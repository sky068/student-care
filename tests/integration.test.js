import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const port = 31000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let dataDir;
let server;

async function request(pathname, { token, ...options } = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined || typeof options.body === "string" ? options.body : JSON.stringify(options.body)
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("测试服务器启动超时");
}

async function registerAndLogin(account, role) {
  let result = await request("/api/auth/register", {
    method: "POST",
    body: { account, password: "123456", name: account, role }
  });
  assert.equal(result.response.status, 201);
  result = await request("/api/auth/login", { method: "POST", body: { account, password: "123456" } });
  assert.equal(result.response.status, 200);
  return result.body.token;
}

test.before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "stumng-test-"));
  server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_ACCOUNT: "", ADMIN_PASSWORD: "" },
    stdio: "ignore"
  });
  await waitForServer();
});

test.after(async () => {
  server?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

test("关键权限、并发和输入边界", async () => {
  const ownerToken = await registerAndLogin("owner", "teacher");
  const parentToken = await registerAndLogin("parent", "parent");
  const outsiderToken = await registerAndLogin("outsider", "parent");
  const helperToken = await registerAndLogin("helper", "teacher");

  let result = await request("/api/classes", {
    token: ownerToken,
    method: "POST",
    body: { className: "测试班" }
  });
  assert.equal(result.response.status, 201);
  const classItem = result.body.class;
  assert.notEqual(classItem.classCode, classItem.teacherInviteCode);

  result = await request("/api/classes/join-by-code", {
    token: helperToken,
    method: "POST",
    body: { classCode: classItem.classCode }
  });
  assert.equal(result.response.status, 404, "教师不能使用家长绑定码加入");
  result = await request("/api/classes/join-by-code", {
    token: helperToken,
    method: "POST",
    body: { classCode: classItem.teacherInviteCode }
  });
  assert.equal(result.response.status, 201);

  result = await request("/api/students/bind-by-class-code", {
    token: parentToken,
    method: "POST",
    body: { classCode: classItem.classCode, studentName: "小明" }
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.class.teacherInviteCode, undefined, "家长响应不能泄露教师邀请码");
  const studentId = result.body.student.id;

  const taskResults = await Promise.all(["任务一", "任务二"].map((title) => request("/api/tasks", {
    token: parentToken,
    method: "POST",
    body: { studentId, date: "2026-07-15", title }
  })));
  assert.deepEqual(taskResults.map((item) => item.response.status), [201, 201]);
  result = await request(`/api/tasks?studentId=${studentId}&date=2026-07-15`, { token: parentToken });
  assert.equal(result.body.tasks.length, 2, "并发写入不能丢任务");

  result = await request("/api/operation-logs", { token: outsiderToken });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.logs.length, 0, "无关家长不能看到其他租户日志");

  result = await request(`/api/classes/${classItem.id}/students/${studentId}`, { token: ownerToken, method: "DELETE", body: {} });
  assert.equal(result.response.status, 200);
  result = await request(`/api/tasks?studentId=${studentId}&date=2026-07-15`, { token: parentToken });
  assert.equal(result.response.status, 403, "学生移除后旧绑定不能继续访问");

  result = await request(`/api/tasks?studentId=${studentId}&date=2026-02-30`, { token: ownerToken });
  assert.equal(result.response.status, 400);
  result = await request("/api/auth/login", { method: "POST", body: `{"account":"x","padding":"${"x".repeat(70 * 1024)}"}` });
  assert.equal(result.response.status, 413);
});
