import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const port = 31000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let dataDir;
let server;
let adminAccount = "test-admin";
let adminPassword = "Admin!123456";
const newUserPassword = "Test!1234";

async function request(pathname, { token, activeRole, ...options } = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (activeRole) headers["x-active-role"] = activeRole;
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

async function startServer() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_ACCOUNT: adminAccount,
      ADMIN_PASSWORD: adminPassword,
      ADMIN_NAME: "测试管理员"
    },
    stdio: "ignore"
  });
  await waitForServer();
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, "exit");
  server.kill();
  await exited;
}

async function registerAndLogin(account, role) {
  let result = await request("/api/auth/register", {
    method: "POST",
    body: { account, password: newUserPassword, name: account, role }
  });
  assert.equal(result.response.status, 201);
  result = await request("/api/auth/login", { method: "POST", body: { account, password: newUserPassword } });
  assert.equal(result.response.status, 200);
  return result.body.token;
}

function legacyPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

test.before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "stumng-test-"));
  const database = new Database(path.join(dataDir, "stumng.sqlite"));
  database.exec("CREATE TABLE app_records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (collection, id))");
  const legacyUser = {
    id: "usr_legacy_parent",
    account: "legacy-parent",
    passwordHash: legacyPasswordHash("123456"),
    name: "旧版家长",
    role: "parent",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  database.prepare("INSERT INTO app_records (collection, id, data, updated_at) VALUES (?, ?, ?, ?)")
    .run("users", legacyUser.id, JSON.stringify(legacyUser), legacyUser.updatedAt);
  const legacyAdmin = {
    id: "usr_legacy_admin",
    account: "old-env-admin",
    passwordHash: legacyPasswordHash("old-admin-password"),
    name: "旧版管理员",
    role: "admin",
    status: "active",
    createdAt: legacyUser.createdAt,
    updatedAt: legacyUser.updatedAt
  };
  database.prepare("INSERT INTO app_records (collection, id, data, updated_at) VALUES (?, ?, ?, ?)")
    .run("users", legacyAdmin.id, JSON.stringify(legacyAdmin), legacyAdmin.updatedAt);
  const legacyTask = {
    id: "tsk_legacy",
    studentId: "stu_legacy",
    date: "2026-07-15",
    title: "旧版任务",
    status: "pending",
    createdBy: legacyUser.id,
    lastModifiedBy: legacyUser.id,
    completedBy: null,
    deleted: false,
    createdAt: legacyUser.createdAt,
    updatedAt: legacyUser.updatedAt
  };
  const legacyAttendance = {
    id: "att_legacy",
    studentId: "stu_legacy",
    date: "2026-07-15",
    morningStatus: "normal",
    afternoonStatus: "normal",
    createdBy: legacyUser.id,
    lastModifiedBy: legacyUser.id,
    createdAt: legacyUser.createdAt,
    updatedAt: legacyUser.updatedAt
  };
  const insertRecord = database.prepare("INSERT INTO app_records (collection, id, data, updated_at) VALUES (?, ?, ?, ?)");
  insertRecord.run("dailyTasks", legacyTask.id, JSON.stringify(legacyTask), legacyTask.updatedAt);
  insertRecord.run("attendanceRecords", legacyAttendance.id, JSON.stringify(legacyAttendance), legacyAttendance.updatedAt);
  const legacySession = { token: "legacy_session_token", userId: legacyUser.id, createdAt: new Date().toISOString() };
  insertRecord.run("sessions", legacySession.token, JSON.stringify(legacySession), legacySession.createdAt);
  database.close();
  await startServer();
});

test.after(async () => {
  await stopServer();
  await rm(dataDir, { recursive: true, force: true });
});

test("旧版单角色账号自动兼容为身份列表", async () => {
  const homeResponse = await fetch(baseUrl);
  assert.equal(homeResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(homeResponse.headers.get("x-frame-options"), "DENY");
  assert.match(homeResponse.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  const unauthenticatedApi = await request("/api/auth/me");
  assert.equal(unauthenticatedApi.response.headers.get("cache-control"), "no-store");
  let result = await request("/api/auth/me", { token: "legacy_session_token" });
  assert.equal(result.response.status, 200, "缺少 activeRole 的旧会话应继续有效");
  assert.equal(result.body.user.role, "parent");
  result = await request("/api/auth/login", {
    method: "POST",
    body: { account: "legacy-parent", password: "123456" }
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.user.roles, ["parent"]);
  result = await request("/api/auth/me", { token: result.body.token });
  assert.equal(result.body.user.role, "parent");
  assert.deepEqual(result.body.user.roles, ["parent"]);
  const database = new Database(path.join(dataDir, "stumng.sqlite"), { readonly: true });
  const migratedUser = JSON.parse(database.prepare("SELECT data FROM app_records WHERE collection = ? AND id = ?").get("users", "usr_legacy_parent").data);
  const migratedTask = JSON.parse(database.prepare("SELECT data FROM app_records WHERE collection = ? AND id = ?").get("dailyTasks", "tsk_legacy").data);
  const migratedAttendance = JSON.parse(database.prepare("SELECT data FROM app_records WHERE collection = ? AND id = ?").get("attendanceRecords", "att_legacy").data);
  database.close();
  assert.match(migratedUser.passwordHash, /^pbkdf2\$600000\$/, "旧密码哈希应在成功登录后升级");
  assert.equal(migratedTask.createdByRole, "parent");
  assert.equal(migratedTask.lastModifiedByRole, "parent");
  assert.equal(migratedAttendance.createdByRole, "parent");
  assert.equal(migratedAttendance.lastModifiedByRole, "parent");
});

test("关键权限、并发和输入边界", async () => {
  for (const [password, missing] of [
    ["short", "至少 8 位"],
    ["lowercase!123", "大写字母"],
    ["UPPERCASE!123", "小写字母"],
    ["NoSpecial123", "特殊符号"]
  ]) {
    const weakPasswordResult = await request("/api/auth/register", {
      method: "POST",
      body: { account: `weak-${missing}`, password, name: "弱密码", role: "parent" }
    });
    assert.equal(weakPasswordResult.response.status, 400);
    assert.match(weakPasswordResult.body.error, new RegExp(missing));
  }

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
    body: { classCode: classItem.classCode, studentName: "小明", remark: "花生过敏" }
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.class.teacherInviteCode, undefined, "家长响应不能泄露教师邀请码");
  assert.equal(result.body.student.remark, "花生过敏", "家长填写的备注应保存到孩子信息");
  const studentId = result.body.student.id;

  result = await request(`/api/students/${studentId}/remark`, {
    token: parentToken,
    method: "PATCH",
    body: { remark: "下午由外婆接送" }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.student.remark, "下午由外婆接送");
  result = await request(`/api/students/${studentId}/remark`, {
    token: outsiderToken,
    method: "PATCH",
    body: { remark: "越权修改" }
  });
  assert.equal(result.response.status, 403, "无绑定关系的家长不能修改孩子备注");

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

  const internalErrorResponse = await fetch(`${baseUrl}/%E0%A4%A`);
  assert.equal(internalErrorResponse.status, 500);
  assert.deepEqual(await internalErrorResponse.json(), { error: "服务器错误" }, "内部异常不能向客户端泄露细节");
});

test("同一账号可切换教师和家长身份且操作权限隔离", async () => {
  const token = await registerAndLogin("dual-role", "parent");
  let result = await request("/api/auth/switch-role", { token, method: "POST", body: { role: "teacher" } });
  assert.equal(result.response.status, 403, "未开通的身份不能直接切换");
  result = await request("/api/auth/roles", { token, method: "POST", body: { role: "teacher" } });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.user.roles, ["parent", "teacher"]);
  result = await request("/api/auth/roles", { token, method: "POST", body: { role: "teacher" } });
  assert.equal(result.body.alreadyExists, true, "重复开通身份应为无副作用操作");

  result = await request("/api/auth/switch-role", { token, method: "POST", body: { role: "teacher" } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.user.role, "teacher");
  result = await request("/api/auth/switch-role", { token, method: "POST", body: { role: "teacher" } });
  assert.equal(result.body.alreadyActive, true, "切换到当前身份应为无副作用操作");
  result = await request("/api/auth/me", { token, activeRole: "parent" });
  assert.equal(result.response.status, 409, "切换后到达的旧身份请求必须被拒绝");

  result = await request("/api/classes", { token, method: "POST", body: { className: "双身份班级" } });
  assert.equal(result.response.status, 201);
  const classItem = result.body.class;

  result = await request("/api/auth/switch-role", { token, method: "POST", body: { role: "parent" } });
  assert.equal(result.body.user.role, "parent");
  result = await request("/api/students/bind-by-class-code", {
    token,
    method: "POST",
    body: { classCode: classItem.classCode, studentName: "双身份孩子" }
  });
  assert.equal(result.response.status, 201);
  const studentId = result.body.student.id;

  result = await request("/api/tasks", {
    token,
    method: "POST",
    body: { studentId, date: "2026-07-15", title: "家长身份任务" }
  });
  assert.equal(result.response.status, 201);
  const parentTask = result.body.task;
  assert.equal(parentTask.createdByRole, "parent");

  await request("/api/auth/switch-role", { token, method: "POST", body: { role: "teacher" } });
  result = await request(`/api/tasks/${parentTask.id}`, {
    token,
    method: "PUT",
    body: { title: "越权修改", content: "" }
  });
  assert.equal(result.response.status, 403, "教师身份不能修改同账号以家长身份创建的任务");

  result = await request("/api/tasks", {
    token,
    method: "POST",
    body: { studentId, date: "2026-07-15", title: "教师身份任务" }
  });
  assert.equal(result.response.status, 201);
  const teacherTask = result.body.task;
  assert.equal(teacherTask.createdByRole, "teacher");

  await request("/api/auth/switch-role", { token, method: "POST", body: { role: "parent" } });
  result = await request(`/api/tasks/${teacherTask.id}`, {
    token,
    method: "DELETE",
    body: {}
  });
  assert.equal(result.response.status, 403, "家长身份不能删除同账号以教师身份创建的任务");

  result = await request("/api/auth/me", { token });
  assert.equal(result.body.user.role, "parent");
  assert.deepEqual(result.body.user.roles, ["parent", "teacher"]);
  assert.equal(result.body.classes.length, 0, "家长身份不返回教师班级列表");
  assert.equal(result.body.students.length, 1);

  await request("/api/auth/logout", { token, method: "POST", body: {} });
  result = await request("/api/auth/login", {
    method: "POST",
    body: { account: "dual-role", password: newUserPassword }
  });
  assert.equal(result.body.user.role, "parent", "重新登录应恢复上次使用身份");
});

test("管理员身份不能开通或切换普通身份", async () => {
  let result = await request("/api/auth/login", {
    method: "POST",
    body: { account: "test-admin", password: "Admin!123456" }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.user.environmentPasswordFingerprint, undefined, "管理员响应不能暴露环境密码校验哈希");
  const oldAdminLogin = await request("/api/auth/login", {
    method: "POST",
    body: { account: "old-env-admin", password: "old-admin-password" }
  });
  assert.equal(oldAdminLogin.response.status, 401, "旧版环境管理员应迁移而不是保留第二个入口");
  const token = result.body.token;
  result = await request("/api/auth/roles", { token, method: "POST", body: { role: "parent" } });
  assert.equal(result.response.status, 403);
  result = await request("/api/auth/switch-role", { token, method: "POST", body: { role: "parent" } });
  assert.equal(result.response.status, 403);
});

test("环境管理员可安全改名且网页改密不会被旧环境密码覆盖", async () => {
  let result = await request("/api/auth/login", {
    method: "POST",
    body: { account: adminAccount, password: adminPassword }
  });
  assert.equal(result.response.status, 200);
  const adminId = result.body.user.id;
  const weakReset = await request(`/api/users/${adminId}/password`, {
    token: result.body.token,
    method: "PATCH",
    body: { newPassword: "lowercase!123" }
  });
  assert.equal(weakReset.response.status, 400);
  assert.match(weakReset.body.error, /大写字母/);
  const webPassword = "Web-password!123456";
  result = await request(`/api/users/${adminId}/password`, {
    token: result.body.token,
    method: "PATCH",
    body: { newPassword: webPassword }
  });
  assert.equal(result.response.status, 200);

  await stopServer();
  await startServer();
  result = await request("/api/auth/login", {
    method: "POST",
    body: { account: adminAccount, password: webPassword }
  });
  assert.equal(result.response.status, 200, "服务重启后应保留网页修改的管理员密码");
  result = await request("/api/auth/login", {
    method: "POST",
    body: { account: adminAccount, password: adminPassword }
  });
  assert.equal(result.response.status, 401, "旧环境密码不应在普通重启后恢复");

  await stopServer();
  const oldAccount = adminAccount;
  adminAccount = "test-admin-renamed";
  await startServer();
  result = await request("/api/auth/login", {
    method: "POST",
    body: { account: oldAccount, password: webPassword }
  });
  assert.equal(result.response.status, 401, "环境管理员改名后旧账号必须失效");
  result = await request("/api/auth/login", {
    method: "POST",
    body: { account: adminAccount, password: webPassword }
  });
  assert.equal(result.response.status, 200);

  await stopServer();
  adminPassword = "Rotated-environment!Password";
  await startServer();
  result = await request("/api/auth/login", {
    method: "POST",
    body: { account: adminAccount, password: adminPassword }
  });
  assert.equal(result.response.status, 200, "环境密码改为新值后应主动轮换管理员密码");
  result = await request("/api/auth/login", {
    method: "POST",
    body: { account: adminAccount, password: webPassword }
  });
  assert.equal(result.response.status, 401);
});

test("环境管理员账号不能覆盖已有普通账号", async () => {
  await stopServer();
  server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_ACCOUNT: "parent",
      ADMIN_PASSWORD: "Another-admin!Password",
      ADMIN_NAME: "冲突管理员"
    },
    stdio: "ignore"
  });
  const [exitCode] = await once(server, "exit");
  assert.notEqual(exitCode, 0, "普通账号与环境管理员账号冲突时服务必须拒绝启动");
});
