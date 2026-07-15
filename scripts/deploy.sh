#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.deploy"
COMPOSE_FILE="$ROOT_DIR/compose.yaml"
DATA_DIR=""

usage() {
  cat <<'EOF'
用法：./scripts/deploy.sh [命令]

命令：
  deploy   首次部署或重新构建并启动（默认）
  update   备份数据库后构建新版本，失败时自动回滚
  status   查看容器状态
  logs     持续查看应用日志
  backup   在线备份 SQLite 数据库并清理过期备份
  stop     停止服务但保留数据
  down     停止并移除容器但保留数据
EOF
}

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'
}

deployment_uid() {
  if [[ "$(id -u)" == "0" ]]; then echo "10001"; else id -u; fi
}

deployment_gid() {
  if [[ "$(id -g)" == "0" ]]; then echo "10001"; else id -g; fi
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

  local password bind trust_proxy
  password="Aa!$(openssl rand -hex 16)"
  bind="${APP_BIND:-127.0.0.1}"
  if [[ -n "${TRUST_PROXY:-}" ]]; then
    trust_proxy="$TRUST_PROXY"
  elif [[ "$bind" == "0.0.0.0" ]]; then
    trust_proxy="false"
  else
    trust_proxy="true"
  fi
  {
    echo "APP_PORT=${APP_PORT:-3000}"
    echo "APP_BIND=$bind"
    echo "ALLOW_INSECURE_HTTP=${ALLOW_INSECURE_HTTP:-false}"
    echo "DOMAIN=${DOMAIN:-}"
    echo "PORT=3000"
    echo "DATA_DIR=/app/data"
    echo "HOST_DATA_DIR=${HOST_DATA_DIR:-./data}"
    echo "TRUST_PROXY=$trust_proxy"
    echo "BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}"
    echo "APP_IMAGE=${APP_IMAGE:-stumng:local}"
    echo "ADMIN_ACCOUNT=${ADMIN_ACCOUNT:-admin}"
    echo "ADMIN_PASSWORD=$password"
    echo "ADMIN_NAME=${ADMIN_NAME:-系统管理员}"
    echo "HOST_UID=$(deployment_uid)"
    echo "HOST_GID=$(deployment_gid)"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  echo "已创建 $ENV_FILE"
  echo "管理员账号：${ADMIN_ACCOUNT:-admin}"
  echo "管理员随机初始密码已安全写入 .env.deploy，不在终端日志中显示。"
  echo "请通过受控方式查看 ADMIN_PASSWORD，并妥善保管该文件。"
}

require_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "错误：未找到 $ENV_FILE，请先执行 ./scripts/deploy.sh deploy。" >&2
    exit 1
  fi
}

ensure_env_defaults() {
  local key value
  while IFS='|' read -r key value; do
    if ! grep -q "^${key}=" "$ENV_FILE"; then
      echo "${key}=${value}" >> "$ENV_FILE"
    fi
  done <<'EOF'
APP_BIND|127.0.0.1
ALLOW_INSECURE_HTTP|false
DOMAIN|
TRUST_PROXY|true
BACKUP_RETENTION_DAYS|30
APP_IMAGE|stumng:local
EOF
}

validate_env() {
  chmod 600 "$ENV_FILE"
  local account password uid gid retention domain raw_data_dir bind port allow_insecure_http trust_proxy
  account="$(env_value ADMIN_ACCOUNT)"
  password="$(env_value ADMIN_PASSWORD)"
  uid="$(env_value HOST_UID)"
  gid="$(env_value HOST_GID)"
  retention="$(env_value BACKUP_RETENTION_DAYS)"
  domain="$(env_value DOMAIN)"
  bind="$(env_value APP_BIND)"
  allow_insecure_http="$(env_value ALLOW_INSECURE_HTTP)"
  trust_proxy="$(env_value TRUST_PROXY)"
  port="$(env_value APP_PORT)"
  raw_data_dir="$(env_value HOST_DATA_DIR)"

  if [[ -z "$account" || ${#account} -gt 64 ]]; then
    echo "错误：.env.deploy 中 ADMIN_ACCOUNT 必须为 1 至 64 个字符。" >&2
    exit 1
  fi
  if [[ ${#password} -lt 8 || ${#password} -gt 128 || "$password" == "change-this-password" || "$password" == "change_me_before_deploy" || ! "$password" =~ [A-Z] || ! "$password" =~ [a-z] || ! "$password" =~ [^A-Za-z0-9[:space:]] ]]; then
    echo "错误：ADMIN_PASSWORD 必须为 8 至 128 位，包含大写字母、小写字母和特殊符号，且不能使用示例密码。" >&2
    exit 1
  fi
  if [[ "$uid" == "0" || "$gid" == "0" || ! "$uid" =~ ^[0-9]+$ || ! "$gid" =~ ^[0-9]+$ ]]; then
    echo "错误：HOST_UID/HOST_GID 必须是非 root 的数字用户和用户组。" >&2
    exit 1
  fi
  if [[ "$(id -u)" != "0" && ( "$uid" != "$(id -u)" || "$gid" != "$(id -g)" ) ]]; then
    echo "错误：HOST_UID/HOST_GID 必须与当前部署用户一致，请填写 $(id -u):$(id -g)。" >&2
    exit 1
  fi
  if [[ -z "$retention" || ! "$retention" =~ ^[0-9]+$ || "$retention" -lt 1 ]]; then
    echo "错误：BACKUP_RETENTION_DAYS 必须是大于 0 的整数。" >&2
    exit 1
  fi
  if [[ -n "$domain" && ( "$domain" == *"://"* || ! "$domain" =~ ^[A-Za-z0-9.-]+$ ) ]]; then
    echo "错误：DOMAIN 只能填写域名本身，例如 care.example.com。" >&2
    exit 1
  fi
  if [[ -n "$domain" && "$domain" != *.* ]]; then
    echo "错误：DOMAIN 必须是可公开解析的完整域名。" >&2
    exit 1
  fi
  if [[ "$bind" != "127.0.0.1" && "$bind" != "0.0.0.0" ]]; then
    echo "错误：APP_BIND 只允许填写 127.0.0.1 或 0.0.0.0。" >&2
    exit 1
  fi
  if [[ "$allow_insecure_http" != "true" && "$allow_insecure_http" != "false" ]]; then
    echo "错误：ALLOW_INSECURE_HTTP 只能填写 true 或 false。" >&2
    exit 1
  fi
  if [[ "$trust_proxy" != "true" && "$trust_proxy" != "false" ]]; then
    echo "错误：TRUST_PROXY 只能填写 true 或 false。" >&2
    exit 1
  fi
  if [[ "$bind" == "0.0.0.0" ]]; then
    if [[ "$allow_insecure_http" != "true" ]]; then
      echo "错误：公网 IP 直连必须显式设置 ALLOW_INSECURE_HTTP=true。" >&2
      exit 1
    fi
    if [[ -n "$domain" ]]; then
      echo "错误：配置 DOMAIN 时 APP_BIND 必须保持 127.0.0.1，由 Caddy 提供 HTTPS。" >&2
      exit 1
    fi
    if [[ "$trust_proxy" != "false" ]]; then
      echo "错误：公网 IP 直连必须设置 TRUST_PROXY=false，避免客户端伪造来源地址。" >&2
      exit 1
    fi
    echo "警告：当前启用了公网 HTTP，登录密码和业务数据不会经过 HTTPS 加密。仅建议临时使用，并在安全组中限制来源 IP。" >&2
  elif [[ -n "$domain" && "$trust_proxy" != "true" ]]; then
    echo "错误：使用内置 Caddy HTTPS 时必须设置 TRUST_PROXY=true。" >&2
    exit 1
  fi
  if [[ -z "$port" || ! "$port" =~ ^[0-9]+$ || "$port" -lt 1 || "$port" -gt 65535 ]]; then
    echo "错误：APP_PORT 必须是 1 至 65535 的端口号。" >&2
    exit 1
  fi
  if [[ -z "$raw_data_dir" ]]; then
    echo "错误：HOST_DATA_DIR 不能为空。" >&2
    exit 1
  fi

  if [[ "$raw_data_dir" == /* ]]; then
    DATA_DIR="$raw_data_dir"
  else
    DATA_DIR="$ROOT_DIR/${raw_data_dir#./}"
  fi
}

prepare_data_dir() {
  mkdir -p "$DATA_DIR" "$DATA_DIR/backups"
  if [[ "$(id -u)" == "0" ]]; then
    chown -R "$(env_value HOST_UID):$(env_value HOST_GID)" "$DATA_DIR"
  fi
  chmod 700 "$DATA_DIR" "$DATA_DIR/backups"
  local file
  for file in "$DATA_DIR"/stumng.sqlite* "$DATA_DIR"/backups/stumng-*.sqlite; do
    if [[ -e "$file" ]]; then
      chmod 600 "$file"
    fi
  done
}

compose() {
  local args=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
  if [[ -n "$(env_value DOMAIN)" ]]; then
    args+=(--profile https)
  fi
  "${args[@]}" "$@"
}

compose_with_https_profile() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile https "$@"
}

reconcile_proxy() {
  if [[ -z "$(env_value DOMAIN)" ]]; then
    compose_with_https_profile stop caddy >/dev/null 2>&1 || true
    compose_with_https_profile rm -f caddy >/dev/null 2>&1 || true
  fi
}

wait_for_health() {
  local container_id status attempt
  container_id="$(compose ps -q app)"
  if [[ -z "$container_id" ]]; then
    echo "错误：应用容器未创建。" >&2
    return 1
  fi

  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
    if [[ "$status" == "healthy" ]]; then
      echo "应用健康检查通过。"
      return 0
    fi
    if [[ "$status" == "unhealthy" ]]; then
      break
    fi
    sleep 2
  done

  echo "错误：应用未能通过健康检查，最近日志如下：" >&2
  compose logs --tail=100 app >&2
  return 1
}

wait_for_https() {
  local domain attempt
  domain="$(env_value DOMAIN)"
  [[ -z "$domain" ]] && return 0
  if ! command -v curl >/dev/null 2>&1; then
    echo "错误：启用自动 HTTPS 时需要 curl 验证证书和访问状态。" >&2
    return 1
  fi
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if curl --fail --silent --show-error --max-time 5 "https://$domain/" >/dev/null 2>&1; then
      echo "HTTPS 健康检查通过。"
      return 0
    fi
    sleep 2
  done
  echo "错误：https://$domain 未能通过检查，请确认 DNS 已解析且防火墙开放 80/443。" >&2
  compose logs --tail=100 caddy >&2
  return 1
}

show_access_url() {
  local domain port bind
  domain="$(env_value DOMAIN)"
  port="$(env_value APP_PORT)"
  bind="$(env_value APP_BIND)"
  if [[ -n "$domain" ]]; then
    echo "访问地址：https://$domain"
  elif [[ "$bind" == "0.0.0.0" ]]; then
    echo "访问地址：http://服务器公网IP:${port:-3000}"
    echo "警告：当前为明文 HTTP，请尽快配置域名并切换到 HTTPS。"
  else
    echo "应用仅监听本机：http://127.0.0.1:${port:-3000}"
    echo "如需公网访问，请在 .env.deploy 配置 DOMAIN 并将域名解析到本服务器。"
  fi
}

cleanup_old_backups() {
  local retention
  retention="$(env_value BACKUP_RETENTION_DAYS)"
  find "$DATA_DIR/backups" -type f -name 'stumng-*.sqlite' -mtime "+$retention" -delete
}

backup_database() {
  if [[ ! -f "$DATA_DIR/stumng.sqlite" ]]; then
    echo "尚无数据库，跳过备份。"
    return
  fi
  if ! compose ps --status running --services | grep -qx app; then
    echo "错误：在线备份要求应用容器正在运行。" >&2
    return 1
  fi

  local filename destination
  filename="stumng-$(date +%Y%m%d-%H%M%S).sqlite"
  destination="/app/data/backups/$filename"
  compose exec -T app node -e \
    'const Database=require("better-sqlite3");const db=new Database("/app/data/stumng.sqlite");db.backup(process.argv[1]).then(()=>db.close()).catch((error)=>{console.error(error);process.exitCode=1});' \
    "$destination"
  chmod 600 "$DATA_DIR/backups/$filename"
  cleanup_old_backups
  echo "数据库已备份到：$DATA_DIR/backups/$filename"
}

deploy_application() {
  reconcile_proxy
  compose up -d --build
  wait_for_health
  wait_for_https
  compose ps
  show_access_url
}

update_application() {
  local container_id previous_image app_image
  backup_database
  container_id="$(compose ps -q app)"
  if [[ -z "$container_id" ]]; then
    echo "错误：没有正在运行的旧版本，首次启动请使用 deploy 命令。" >&2
    return 1
  fi
  previous_image="$(docker inspect --format '{{.Image}}' "$container_id")"
  app_image="$(env_value APP_IMAGE)"
  app_image="${app_image:-stumng:local}"

  if ! compose build app; then
    echo "错误：新镜像构建失败，旧版本仍在运行。" >&2
    return 1
  fi
  reconcile_proxy
  if compose up -d --no-build && wait_for_health; then
    if ! wait_for_https; then
      echo "新应用已启动，但 HTTPS 未就绪；未回滚健康的应用版本。" >&2
      return 1
    fi
    compose ps
    show_access_url
    return
  fi

  echo "新版本启动失败，正在自动回滚上一镜像……" >&2
  docker tag "$previous_image" "$app_image"
  compose up -d --force-recreate --no-build
  if wait_for_health && wait_for_https; then
    echo "已回滚到上一版本。" >&2
  else
    echo "错误：自动回滚也未通过健康检查，请立即人工处理。" >&2
  fi
  return 1
}

main() {
  local command="${1:-deploy}"
  if [[ "$command" == "-h" || "$command" == "--help" || "$command" == "help" ]]; then
    usage
    return
  fi
  case "$command" in
    deploy|update|status|logs|backup|stop|down) ;;
    *)
      echo "错误：未知命令 $command" >&2
      usage >&2
      exit 1
      ;;
  esac

  require_docker
  if [[ "$command" == "deploy" ]]; then create_env_if_missing; else require_env; fi
  ensure_env_defaults
  validate_env
  if [[ "$command" == "deploy" || "$command" == "update" || "$command" == "backup" ]]; then
    prepare_data_dir
  fi

  case "$command" in
    deploy) deploy_application ;;
    update) update_application ;;
    status) compose ps ;;
    logs)
      if [[ -n "$(env_value DOMAIN)" ]]; then
        compose logs -f --tail=200 app caddy
      else
        compose logs -f --tail=200 app
      fi
      ;;
    backup) backup_database ;;
    stop) compose stop ;;
    down) compose down ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
