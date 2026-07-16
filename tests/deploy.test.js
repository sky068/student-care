import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function validateDeployEnv(password) {
  const directory = await mkdtemp(path.join(tmpdir(), "stumng-deploy-test-"));
  const envFile = path.join(directory, ".env.deploy");
  const dataDir = path.join(directory, "data");
  await writeFile(envFile, [
    "APP_PORT=3000",
    "APP_BIND=127.0.0.1",
    "ALLOW_INSECURE_HTTP=false",
    "DOMAIN=",
    `HOST_DATA_DIR=${dataDir}`,
    "TRUST_PROXY=true",
    "BACKUP_RETENTION_DAYS=30",
    "APP_IMAGE=stumng:test",
    "ADMIN_ACCOUNT=admin",
    `ADMIN_PASSWORD=${password}`,
    "ADMIN_NAME=系统管理员",
    `HOST_UID=${process.getuid()}`,
    `HOST_GID=${process.getgid()}`
  ].join("\n"));
  try {
    return await execFileAsync("bash", ["-c", 'source scripts/deploy.sh; ENV_FILE="$1"; validate_env', "--", envFile], {
      cwd: process.cwd()
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("部署脚本拒绝所有已知示例管理员密码", async () => {
  for (const password of ["Aa!1234", "change-this-password", "change_me_before_deploy", "lowercase-password!2026", "UPPERCASE-PASSWORD!2026", "NoSpecialPassword2026"]) {
    await assert.rejects(validateDeployEnv(password), /ADMIN_PASSWORD/);
  }
});

test("部署脚本接受满足规则的强管理员密码", async () => {
  await assert.doesNotReject(validateDeployEnv("Admin!8a"));
});

test("Docker 构建可在预编译包不可用时编译 SQLite 依赖", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS dependencies/);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends python3 make g\+\+/);
  assert.match(dockerfile, /COPY --from=dependencies --chown=node:node \/app\/node_modules \.\/node_modules/);
});
