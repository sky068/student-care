#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.deploy"
COMPOSE_FILE="$ROOT_DIR/compose.yaml"
DATA_DIR="$ROOT_DIR/data"

usage() {
  cat <<'EOF'
用法：./scripts/deploy.sh [命令]

命令：
  deploy   首次部署或重新构建并启动（默认）
  update   备份数据库后重新构建并启动
  status   查看容器状态
  logs     持续查看应用日志
  backup   在线备份 SQLite 数据库
  stop     停止服务但保留数据
  down     停止并移除容器但保留数据
EOF
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "错误：未安装 Docker。请先安装 Docker Engine 和 Compose 插件。" >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "错误：未安装 docker compose 插件。" >&2
    exit 1
  fi
}

create_env_if_missing() {
  if [[ -f "$ENV_FILE" ]]; then
    return
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "错误：首次部署需要 openssl 生成随机管理员密码。" >&2
    exit 1
  fi

  local password
  password="$(openssl rand -hex 18)"
  umask 077
  {
    echo "APP_PORT=${APP_PORT:-3000}"
    echo "PORT=3000"
    echo "DATA_DIR=/app/data"
    echo "HOST_DATA_DIR=./data"
    echo "ADMIN_ACCOUNT=${ADMIN_ACCOUNT:-admin}"
    echo "ADMIN_PASSWORD=$password"
    echo "ADMIN_NAME=${ADMIN_NAME:-系统管理员}"
    echo "HOST_UID=$(id -u)"
    echo "HOST_GID=$(id -g)"
  } > "$ENV_FILE"

  echo "已创建 $ENV_FILE"
  echo "管理员账号：${ADMIN_ACCOUNT:-admin}"
  echo "管理员初始密码：$password"
  echo "请立即保存密码，登录后妥善保管 .env.deploy。"
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

wait_for_health() {
  local container_id status attempt
  container_id="$(compose ps -q app)"
  if [[ -z "$container_id" ]]; then
    echo "错误：应用容器未创建。" >&2
    exit 1
  fi

  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
    if [[ "$status" == "healthy" ]]; then
      echo "应用健康检查通过。"
      return
    fi
    if [[ "$status" == "unhealthy" ]]; then
      break
    fi
    sleep 2
  done

  echo "错误：应用未能通过健康检查，最近日志如下：" >&2
  compose logs --tail=100 app >&2
  exit 1
}

backup_database() {
  mkdir -p "$DATA_DIR/backups"
  if [[ ! -f "$DATA_DIR/stumng.sqlite" ]]; then
    echo "尚无数据库，跳过备份。"
    return
  fi
  if ! compose ps --status running --services | grep -qx app; then
    echo "错误：在线备份要求应用容器正在运行。" >&2
    exit 1
  fi

  local filename destination
  filename="stumng-$(date +%Y%m%d-%H%M%S).sqlite"
  destination="/app/data/backups/$filename"
  compose exec -T app node -e \
    'const Database=require("better-sqlite3");const db=new Database("/app/data/stumng.sqlite");db.backup(process.argv[1]).then(()=>db.close());' \
    "$destination"
  echo "数据库已备份到：$DATA_DIR/backups/$filename"
}

main() {
  local command="${1:-deploy}"
  if [[ "$command" == "-h" || "$command" == "--help" || "$command" == "help" ]]; then
    usage
    return
  fi
  require_docker
  create_env_if_missing
  mkdir -p "$DATA_DIR"

  case "$command" in
    deploy)
      compose up -d --build
      wait_for_health
      compose ps
      ;;
    update)
      backup_database
      compose up -d --build
      wait_for_health
      compose ps
      ;;
    status)
      compose ps
      ;;
    logs)
      compose logs -f --tail=200 app
      ;;
    backup)
      backup_database
      ;;
    stop)
      compose stop
      ;;
    down)
      compose down
      ;;
    *)
      echo "错误：未知命令 $command" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
