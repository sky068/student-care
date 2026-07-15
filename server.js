import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

process.umask(0o077);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, ".env"));

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "stumng.sqlite");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ADMIN_ACCOUNT = process.env.ADMIN_ACCOUNT || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_NAME = process.env.ADMIN_NAME || "系统管理员";
const TRUST_PROXY = ["1", "true", "yes"].includes(String(process.env.TRUST_PROXY || "").toLowerCase());
const LOG_HOT_DAYS = 14;
const LOG_RETENTION_DAYS = 180;
const LOG_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BUSINESS_TIME_ZONE = "Asia/Shanghai";
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = 30;
const MUTATION_RATE_LIMIT_MAX = 120;
const INVITE_RATE_LIMIT_MAX = 30;
const MAX_CLASSES_PER_TEACHER = 50;
const MAX_STUDENTS_PER_PARENT = 50;
const MAX_TASKS_PER_STUDENT_DATE = 100;
const PASSWORD_HASH_ITERATIONS = 600000;
const PASSWORD_REQUIREMENTS = "密码至少 8 位，且必须包含大写字母、小写字母和特殊符号";
const authAttempts = new Map();
const actionAttempts = new Map();

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const initialDb = {
  users: [],
  sessions: [],
  classes: [],
  students: [],
  parentStudentRelations: [],
  teacherClassRelations: [],
  attendanceRecords: [],
  dailyTasks: [],
  operationLogs: []
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};
const securityHeaders = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; img-src 'self' data: https://images.unsplash.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};
const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function ensureDb() {
  await mkdir(DATA_DIR, { recursive: true });
  const database = openDatabase();
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_records (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    );
    CREATE INDEX IF NOT EXISTS idx_app_records_collection ON app_records(collection);
    CREATE TABLE IF NOT EXISTS operation_log_archive (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operation_log_archive_created_at ON operation_log_archive(created_at);
    CREATE TABLE IF NOT EXISTS maintenance_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function maintainOperationLogs(database, force = false) {
  const maintenanceKey = "operation_logs";
  const lastRun = database.prepare("SELECT value FROM maintenance_state WHERE key = ?").get(maintenanceKey)?.value;
  const currentTime = Date.now();
  if (!force && lastRun && currentTime - Date.parse(lastRun) < LOG_MAINTENANCE_INTERVAL_MS) return null;

  const hotCutoff = new Date(currentTime - LOG_HOT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const retentionCutoff = new Date(currentTime - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = database.prepare("SELECT id, data, updated_at FROM app_records WHERE collection = ?").all("operationLogs");
  const archive = database.prepare(`
    INSERT INTO operation_log_archive (id, data, created_at, archived_at)
    VALUES (@id, @data, @createdAt, @archivedAt)
    ON CONFLICT(id) DO NOTHING
  `);
  const removeHotLog = database.prepare("DELETE FROM app_records WHERE collection = ? AND id = ?");
  const removeExpiredArchive = database.prepare("DELETE FROM operation_log_archive WHERE created_at < ?");
  const saveMaintenance = database.prepare(`
    INSERT INTO maintenance_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const stats = { archived: 0, deleted: 0 };
  const archivedAt = new Date(currentTime).toISOString();

  database.transaction(() => {
    for (const row of rows) {
      let log = {};
      try {
        log = JSON.parse(row.data);
      } catch {}
      const createdAt = Number.isFinite(Date.parse(log.createdAt)) ? new Date(log.createdAt).toISOString() : row.updated_at;
      if (createdAt < retentionCutoff) {
        removeHotLog.run("operationLogs", row.id);
        stats.deleted += 1;
      } else if (createdAt < hotCutoff) {
        const result = archive.run({ id: row.id, data: row.data, createdAt, archivedAt });
        removeHotLog.run("operationLogs", row.id);
        stats.archived += result.changes;
      }
    }
    stats.deleted += removeExpiredArchive.run(retentionCutoff).changes;
    saveMaintenance.run(maintenanceKey, archivedAt);
  })();

  return stats;
}

async function readDb() {
  await ensureDb();
  maintainOperationLogs(openDatabase());
  const db = Object.fromEntries(Object.keys(initialDb).map((key) => [key, []]));
  const rows = openDatabase().prepare("SELECT collection, data FROM app_records").all();
  for (const row of rows) {
    if (!db[row.collection]) db[row.collection] = [];
    try {
      db[row.collection].push(JSON.parse(row.data));
    } catch {
      console.warn(`已跳过损坏的数据记录：${row.collection}`);
    }
  }
  const studentCodesChanged = ensureStudentCareCodes(db);
  const classCodesChanged = ensureClassInviteCodes(db);
  const userRolesChanged = ensureUserRoles(db);
  const actorRolesChanged = ensureActorRoles(db);
  const sessionsChanged = pruneExpiredSessions(db);
  if (studentCodesChanged || classCodesChanged || userRolesChanged || actorRolesChanged || sessionsChanged) persistDb(openDatabase(), db);
  return db;
}

async function writeDb(db) {
  await mkdir(DATA_DIR, { recursive: true });
  persistDb(openDatabase(), db);
}

function persistDb(database, db) {
  const replace = database.prepare(`
    INSERT INTO app_records (collection, id, data, updated_at)
    VALUES (@collection, @id, @data, @updatedAt)
    ON CONFLICT(collection, id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `);
  const removeCollection = database.prepare("DELETE FROM app_records WHERE collection = ?");
  const transaction = database.transaction(() => {
    for (const collection of Object.keys(initialDb)) {
      removeCollection.run(collection);
      for (const item of db[collection] || []) {
        replace.run({
          collection,
          id: item.id || item.token,
          data: JSON.stringify(item),
          updatedAt: now()
        });
      }
    }
  });
  transaction();
}

let sqlite;

function openDatabase() {
  if (!sqlite) {
    sqlite = new Database(DB_FILE);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
  }
  return sqlite;
}

async function initConfiguredAdmin() {
  if (!ADMIN_ACCOUNT && !ADMIN_PASSWORD) return;
  if (!ADMIN_ACCOUNT || !ADMIN_PASSWORD) {
    console.warn("ADMIN_ACCOUNT 和 ADMIN_PASSWORD 需要同时配置，已跳过管理员初始化");
    return;
  }
  const db = await readDb();
  const managedAdmins = db.users.filter((item) => item.environmentManagedAdmin === true);
  if (managedAdmins.length > 1) throw new Error("检测到多个环境托管管理员，拒绝启动，请先修复管理员数据");
  const managedAdmin = managedAdmins[0];
  const accountOwner = db.users.find((item) => item.account === ADMIN_ACCOUNT);
  const legacyAdmins = db.users.filter((item) => item.role === "admin" && item.environmentManagedAdmin !== true);
  if (managedAdmin && accountOwner && accountOwner.id !== managedAdmin.id) {
    throw new Error(`ADMIN_ACCOUNT ${ADMIN_ACCOUNT} 已被其他账号占用，拒绝启动以避免错误提权`);
  }
  if (!managedAdmin && accountOwner && accountOwner.role !== "admin") {
    throw new Error(`ADMIN_ACCOUNT ${ADMIN_ACCOUNT} 已被普通账号占用，拒绝将其自动提升为管理员`);
  }
  if (!managedAdmin && legacyAdmins.length > 1) {
    throw new Error("检测到多个旧版管理员，无法判断环境托管账号，拒绝自动新增管理员");
  }

  const existing = managedAdmin || accountOwner || (legacyAdmins.length === 1 ? legacyAdmins[0] : null);
  let changed = false;
  if (existing) {
    const update = (field, value) => {
      if (existing[field] === value) return;
      existing[field] = value;
      changed = true;
    };
    update("account", ADMIN_ACCOUNT);
    update("name", ADMIN_NAME);
    update("phone", ADMIN_ACCOUNT);
    update("role", "admin");
    if (JSON.stringify(existing.roles || []) !== JSON.stringify(["admin"])) update("roles", ["admin"]);
    update("lastActiveRole", "admin");
    update("status", "active");
    update("environmentManagedAdmin", true);

    const environmentPasswordChanged = !existing.environmentPasswordFingerprint ||
      !verifyPassword(ADMIN_PASSWORD, existing.environmentPasswordFingerprint);
    if (environmentPasswordChanged) {
      validateNewPassword(ADMIN_PASSWORD, "管理员密码");
      existing.passwordHash = hashPassword(ADMIN_PASSWORD);
      existing.environmentPasswordFingerprint = hashPassword(ADMIN_PASSWORD);
      db.sessions = db.sessions.filter((item) => item.userId !== existing.id);
      changed = true;
    }
    if (changed) existing.updatedAt = now();
  } else {
    validateNewPassword(ADMIN_PASSWORD, "管理员密码");
    db.users.push({
      id: id("usr"),
      account: ADMIN_ACCOUNT,
      passwordHash: hashPassword(ADMIN_PASSWORD),
      name: ADMIN_NAME,
      phone: ADMIN_ACCOUNT,
      role: "admin",
      roles: ["admin"],
      lastActiveRole: "admin",
      environmentManagedAdmin: true,
      environmentPasswordFingerprint: hashPassword(ADMIN_PASSWORD),
      wechatOpenid: "",
      wechatUnionid: "",
      status: "active",
      createdAt: now(),
      updatedAt: now()
    });
    changed = true;
  }
  if (changed) await writeDb(db);
  console.log(`Configured admin ready: ${ADMIN_ACCOUNT}`);
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

function now() {
  return new Date().toISOString();
}

function businessToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex"), iterations = PASSWORD_HASH_ITERATIONS) {
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  let salt;
  let expectedHex;
  let iterations;
  if (stored.startsWith("pbkdf2$")) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    iterations = Number(parts[1]);
    salt = parts[2];
    expectedHex = parts[3];
  } else {
    const parts = stored.split(":");
    if (parts.length !== 2) return false;
    iterations = 100000;
    [salt, expectedHex] = parts;
  }
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000 ||
      expectedHex.length !== 64 || !/^[a-f0-9]+$/i.test(expectedHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = crypto.pbkdf2Sync(password, salt, iterations, expected.length, "sha256");
  return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
}

function passwordHashNeedsUpgrade(stored) {
  return !String(stored || "").startsWith(`pbkdf2$${PASSWORD_HASH_ITERATIONS}$`);
}

function validateNewPassword(password, fieldName = "密码") {
  if (password.length > 128) fail(400, `${fieldName}不能超过 128 位`);
  const missing = [];
  if (password.length < 8) missing.push("至少 8 位");
  if (!/[A-Z]/.test(password)) missing.push("大写字母");
  if (!/[a-z]/.test(password)) missing.push("小写字母");
  if (!/[^A-Za-z0-9\s]/.test(password)) missing.push("特殊符号");
  if (missing.length) fail(400, `${fieldName}不符合要求：缺少${missing.join("、")}。${PASSWORD_REQUIREMENTS}`);
}

function normalizeDate(value) {
  if (!value) return businessToday();
  const date = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, "日期格式必须为 YYYY-MM-DD");
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) fail(400, "日期无效");
  return date;
}

function textInput(value, fieldName, maxLength, required = false) {
  const text = String(value ?? "").trim();
  if (required && !text) fail(400, `${fieldName}不能为空`);
  if (text.length > maxLength) fail(400, `${fieldName}不能超过 ${maxLength} 个字符`);
  return text;
}

function pruneExpiredSessions(db) {
  const nowMs = Date.now();
  const cutoff = nowMs - SESSION_TTL_MS;
  const sessions = db.sessions.filter((session) => {
    const timestamp = Date.parse(session.expiresAt || session.createdAt);
    return Number.isFinite(timestamp) && (session.expiresAt ? timestamp > nowMs : timestamp > cutoff);
  });
  if (sessions.length === db.sessions.length) return false;
  db.sessions = sessions;
  return true;
}

function userRoles(user) {
  if (user?.role === "admin") return ["admin"];
  const configuredRoles = Array.isArray(user?.roles) ? user.roles : [];
  const roles = configuredRoles.filter((role) => ["teacher", "parent"].includes(role));
  if (!roles.length && ["teacher", "parent"].includes(user?.role)) roles.push(user.role);
  return [...new Set(roles)];
}

function hasRole(user, role) {
  return userRoles(user).includes(role);
}

function ensureUserRoles(db) {
  let changed = false;
  for (const user of db.users) {
    const roles = userRoles(user);
    if (JSON.stringify(user.roles || []) !== JSON.stringify(roles)) {
      user.roles = roles;
      changed = true;
    }
    if (!roles.includes(user.lastActiveRole)) {
      user.lastActiveRole = roles[0] || user.role;
      changed = true;
    }
  }
  return changed;
}

function ensureActorRoles(db) {
  let changed = false;
  const roleForUser = (userId) => {
    const role = db.users.find((item) => item.id === userId)?.role;
    return ["teacher", "parent", "admin"].includes(role) ? role : "unknown";
  };
  const fillRole = (record, field, userId) => {
    if (record[field] || !userId) return;
    record[field] = roleForUser(userId);
    changed = true;
  };

  for (const attendance of db.attendanceRecords) {
    fillRole(attendance, "createdByRole", attendance.createdBy);
    fillRole(attendance, "lastModifiedByRole", attendance.lastModifiedBy || attendance.createdBy);
  }
  for (const task of db.dailyTasks) {
    fillRole(task, "createdByRole", task.createdBy);
    fillRole(task, "lastModifiedByRole", task.lastModifiedBy || task.createdBy);
    fillRole(task, "completedByRole", task.completedBy);
    fillRole(task, "teacherRemarkByRole", task.teacherRemarkBy);
  }
  return changed;
}

function cleanUser(user) {
  if (!user) return null;
  const { passwordHash, environmentPasswordFingerprint, ...rest } = user;
  return rest;
}

function publicUser(user, roleOverride = "") {
  if (!user) return null;
  return { id: user.id, name: user.name, role: roleOverride || user.role, roles: userRoles(user), status: user.status };
}

function parentClass(classItem) {
  if (!classItem) return null;
  const { teacherInviteCode, teacherInviteCodeEnabled, ...safe } = classItem;
  return safe;
}

function makeClassCode(db) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = "";
    for (let i = 0; i < 6; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    if (!db.classes.some((item) => item.classCode === code || item.teacherInviteCode === code)) return code;
  }
  throw Object.assign(new Error("班级编号生成失败"), { status: 500 });
}

function ensureClassInviteCodes(db) {
  let changed = false;
  for (const classItem of db.classes) {
    if (!classItem.teacherInviteCode) {
      classItem.teacherInviteCode = makeClassCode(db);
      classItem.teacherInviteCodeEnabled = true;
      changed = true;
    }
  }
  return changed;
}

function send(res, status, body, headers = jsonHeaders) {
  res.writeHead(status, { ...securityHeaders, ...headers });
  res.end(headers["content-type"]?.includes("application/json") ? JSON.stringify(body) : body);
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function enforceAuthRateLimit(req) {
  const forwardedFor = TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
  const key = forwardedFor || req.socket.remoteAddress || "unknown";
  const currentTime = Date.now();
  if (authAttempts.size > 10000) {
    for (const [address, timestamps] of authAttempts) {
      if (!timestamps.some((timestamp) => currentTime - timestamp < AUTH_RATE_LIMIT_WINDOW_MS)) authAttempts.delete(address);
    }
  }
  const recent = (authAttempts.get(key) || []).filter((timestamp) => currentTime - timestamp < AUTH_RATE_LIMIT_WINDOW_MS);
  if (recent.length >= AUTH_RATE_LIMIT_MAX) fail(429, "登录或注册尝试过多，请稍后再试");
  recent.push(currentTime);
  authAttempts.set(key, recent);
}

function clientAddress(req) {
  const forwardedFor = TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
  return forwardedFor || req.socket.remoteAddress || "unknown";
}

function enforceActionRateLimit(req, user, category, maxAttempts) {
  const key = `${category}:${user.id}:${clientAddress(req)}`;
  const currentTime = Date.now();
  const recent = (actionAttempts.get(key) || []).filter((timestamp) => currentTime - timestamp < AUTH_RATE_LIMIT_WINDOW_MS);
  if (recent.length >= maxAttempts) fail(429, "操作过于频繁，请稍后再试");
  recent.push(currentTime);
  actionAttempts.set(key, recent);
  if (actionAttempts.size > 10000) {
    for (const [attemptKey, timestamps] of actionAttempts) {
      if (!timestamps.some((timestamp) => currentTime - timestamp < AUTH_RATE_LIMIT_WINDOW_MS)) actionAttempts.delete(attemptKey);
    }
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) fail(413, "请求内容不能超过 64KB");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || Array.isArray(body) || typeof body !== "object") fail(400, "请求体必须是 JSON 对象");
    return body;
  } catch {
    fail(400, "请求体必须是 JSON");
  }
}

function getToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return "";
}

function currentUser(db, req) {
  const token = getToken(req);
  if (!token) return null;
  const session = db.sessions.find((item) => item.token === token);
  if (!session) return null;
  const expiresAt = Date.parse(session.expiresAt || session.createdAt);
  const validUntil = session.expiresAt ? expiresAt : expiresAt + SESSION_TTL_MS;
  if (!Number.isFinite(validUntil) || validUntil <= Date.now()) return null;
  const user = db.users.find((item) => item.id === session.userId && item.status === "active");
  if (!user) return null;
  const roles = userRoles(user);
  const requestedRole = String(req.headers["x-active-role"] || "");
  const activeRole = roles.includes(session.activeRole) ? session.activeRole : roles[0];
  if (requestedRole && requestedRole !== activeRole) fail(409, "当前身份已切换，请重试");
  if (!activeRole) return null;
  return { ...user, role: activeRole, roles };
}

function requireUser(db, req) {
  const user = currentUser(db, req);
  if (!user) fail(401, "请先登录");
  return user;
}

function requireRole(user, roles) {
  if (!roles.includes(user.role)) fail(403, "没有操作权限");
}

function teacherClassIds(db, userId) {
  return db.teacherClassRelations
    .filter((item) => item.teacherUserId === userId)
    .map((item) => item.classId);
}

function teacherClassRelation(db, userId, classId) {
  return db.teacherClassRelations.find((item) => item.teacherUserId === userId && item.classId === classId) || null;
}

function teacherClassRole(db, userId, classId) {
  const relation = teacherClassRelation(db, userId, classId);
  return relation?.role || (relation ? "owner" : "");
}

function canAccessStudent(db, user, studentId) {
  if (user.role === "admin") return true;
  const student = db.students.find((item) => item.id === studentId && item.status !== "removed");
  if (!student) return false;
  if (user.role === "parent") {
    return db.parentStudentRelations.some((item) => item.parentUserId === user.id && item.studentId === studentId);
  }
  if (user.role === "teacher") {
    const classIds = teacherClassIds(db, user.id);
    return classIds.includes(student.classId);
  }
  return false;
}

function canAccessClass(db, user, classId) {
  if (user.role === "admin") return true;
  if (user.role === "teacher") {
    return Boolean(teacherClassRelation(db, user.id, classId));
  }
  return false;
}

function canManageClassSettings(db, user, classId) {
  if (user.role === "admin") return true;
  return user.role === "teacher" && teacherClassRole(db, user.id, classId) === "owner";
}

function decorateClassForUser(db, classItem, user) {
  if (!classItem) return null;
  const relations = db.teacherClassRelations.filter((item) => item.classId === classItem.id);
  return {
    ...classItem,
    teacherRole: user.role === "teacher" ? teacherClassRole(db, user.id, classItem.id) : "admin",
    teachers: relations.map((relation) => ({
      id: relation.id,
      role: relation.role || "owner",
      teacherUserId: relation.teacherUserId,
      teacher: publicUser(db.users.find((item) => item.id === relation.teacherUserId), "teacher"),
      createdAt: relation.createdAt
    }))
  };
}

function listClassesForUser(db, user) {
  if (user.role === "teacher") {
    return db.classes
      .filter((item) => teacherClassIds(db, user.id).includes(item.id))
      .map((item) => decorateClassForUser(db, item, user));
  }
  if (user.role === "admin") return db.classes.map((item) => decorateClassForUser(db, item, user));
  return [];
}

function formatStudentCareCode(value) {
  return String(value).padStart(2, "0");
}

function normalizedStudentName(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function ensureStudentCareCodes(db) {
  let changed = false;
  const groups = new Map();
  for (const student of db.students) {
    const key = studentDuplicateKey(student);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(student);
  }
  for (const students of groups.values()) {
    students.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    if (students.some((student) => student.careCodeVersion !== 2)) {
      students.forEach((student, index) => {
        const careCode = formatStudentCareCode(index + 1);
        if (student.careCode !== careCode || student.careCodeVersion !== 2) changed = true;
        student.careCode = careCode;
        student.careCodeVersion = 2;
      });
      continue;
    }
    const claimed = new Set();
    let nextNumber = 1;
    for (const student of students) {
      const existing = String(student.careCode || "").trim();
      const normalized = /^\d+$/.test(existing) ? formatStudentCareCode(Number(existing)) : "";
      if (normalized && !claimed.has(normalized)) {
        if (student.careCode !== normalized) changed = true;
        student.careCode = normalized;
        claimed.add(student.careCode);
        continue;
      }
      while (claimed.has(formatStudentCareCode(nextNumber))) nextNumber += 1;
      student.careCode = formatStudentCareCode(nextNumber);
      student.careCodeVersion = 2;
      claimed.add(student.careCode);
      nextNumber += 1;
      changed = true;
    }
  }
  return changed;
}

function nextStudentCareCode(db, classId, studentName) {
  const duplicateKey = studentDuplicateKey({ classId, name: studentName });
  const numbers = db.students
    .filter((student) => studentDuplicateKey(student) === duplicateKey)
    .map((student) => Number(student.careCode))
    .filter((value) => Number.isInteger(value) && value > 0);
  return formatStudentCareCode((numbers.length ? Math.max(...numbers) : 0) + 1);
}

function studentDuplicateKey(student) {
  return `${student.classId}|${normalizedStudentName(student.name)}`;
}

function studentDisplayName(student, group) {
  if (!student) return "";
  const duplicateCount = group.length;
  const sameStudentNoCount = student.studentNo
    ? group.filter((item) => item.studentNo === student.studentNo).length
    : 0;
  let identifier = student.studentNo || "";
  if (duplicateCount > 1 && (!student.studentNo || sameStudentNoCount > 1)) {
    identifier = student.studentNo ? `${student.studentNo} · ${student.careCode}` : student.careCode;
  }
  return identifier ? `${student.name}（${identifier}）` : student.name;
}

function decorateStudentsForTeacher(students, db) {
  const activeStudents = db.students.filter((item) => item.status !== "removed");
  const groups = new Map();
  for (const student of activeStudents) {
    const key = studentDuplicateKey(student);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(student);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  return students.map((student) => {
    const group = groups.get(studentDuplicateKey(student)) || [student];
    const duplicateCount = group.length;
    const duplicateIndex = group.findIndex((item) => item.id === student.id) + 1;
    return {
      ...student,
      displayName: studentDisplayName(student, group),
      duplicateIndex,
      duplicateCount,
      isDuplicate: duplicateCount > 1
    };
  });
}

function decorateStudentForAdmin(student, db) {
  return {
    ...student,
    class: db.classes.find((item) => item.id === student.classId) || null,
    parents: db.parentStudentRelations
      .filter((rel) => rel.studentId === student.id)
      .map((rel) => ({ ...rel, parent: cleanUser(db.users.find((item) => item.id === rel.parentUserId)) }))
  };
}

function decorateParentStudentRelation(relation, db) {
  const student = db.students.find((item) => item.id === relation.studentId) || null;
  return {
    ...relation,
    parent: cleanUser(db.users.find((item) => item.id === relation.parentUserId)),
    student: student ? decorateStudentForAdmin(student, db) : null,
    class: student ? db.classes.find((item) => item.id === student.classId) || null : null
  };
}

function taskStatus(task) {
  if (task.status === "completed" || task.status === "pending") return task.status;
  return task.completed ? "completed" : "pending";
}

function taskActor(db, userId, fallbackLog = null, roleOverride = "") {
  const user = db.users.find((item) => item.id === userId);
  if (!user && !fallbackLog) return null;
  return {
    id: user?.id || userId || fallbackLog.operatorUserId,
    name: user?.name || fallbackLog.operatorName || "未知用户",
    role: roleOverride || fallbackLog?.operatorRole || user?.role || ""
  };
}

function taskCreatedRole(db, task, createLog = null) {
  return task.createdByRole || createLog?.operatorRole || db.users.find((item) => item.id === task.createdBy)?.role || "";
}

function canManageOwnTask(db, user, task) {
  if (user.role === "admin") return true;
  return task.createdBy === user.id && taskCreatedRole(db, task) === user.role;
}

function decorateTask(db, task) {
  const status = taskStatus(task);
  const taskLogs = db.operationLogs
    .filter((item) => item.objectType === "task" && item.objectId === task.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const createLog = taskLogs.find((item) => item.action === "create_task") || null;
  const completionLog = taskLogs.find((item) => item.action === "complete_task") || null;
  const latestLog = taskLogs[0] || null;
  const lastModifiedBy = task.lastModifiedBy || latestLog?.operatorUserId || task.createdBy;
  const createdByRole = taskCreatedRole(db, task, createLog);
  const lastModifiedByRole = task.lastModifiedByRole || latestLog?.operatorRole || createdByRole;
  const completedByRole = task.completedByRole || completionLog?.operatorRole || "";
  return {
    ...task,
    status,
    completed: status === "completed",
    createdByRole,
    lastModifiedBy,
    lastModifiedByRole,
    completedByRole,
    createdByUser: taskActor(db, task.createdBy, createLog, createdByRole),
    lastModifiedByUser: taskActor(db, lastModifiedBy, latestLog, lastModifiedByRole),
    completedByUser: task.completedBy ? taskActor(db, task.completedBy, completionLog, completedByRole) : null
  };
}

function decorateOperationLog(db, log) {
  const snapshot = log.afterData || log.beforeData || {};
  const student = db.students.find((item) => item.id === (log.studentId || snapshot.studentId || snapshot.student?.id));
  const activeStudentGroup = student
    ? db.students.filter((item) => item.status !== "removed" && studentDuplicateKey(item) === studentDuplicateKey(student))
    : [];
  const studentGroup = student && !activeStudentGroup.some((item) => item.id === student.id)
    ? [...activeStudentGroup, student]
    : activeStudentGroup;
  const studentName = student ? studentDisplayName(student, studentGroup.length ? studentGroup : [student]) : "";
  let objectName = "";
  let objectContext = "";

  if (log.objectType === "task") {
    const task = snapshot.title ? snapshot : db.dailyTasks.find((item) => item.id === log.objectId) || {};
    objectName = task.title || "未命名任务";
    objectContext = [studentName, log.date || task.date].filter(Boolean).join(" · ");
  } else if (log.objectType === "attendance") {
    objectName = studentName ? `${studentName}的出勤` : "学生出勤";
    objectContext = log.date || snapshot.date || "";
  } else if (log.objectType === "student") {
    objectName = studentName || snapshot.student?.name || snapshot.name || "学生";
  } else if (log.objectType === "class") {
    objectName = snapshot.class?.className || snapshot.className || db.classes.find((item) => item.id === log.objectId)?.className || "班级";
  } else if (log.objectType === "user") {
    const targetUser = db.users.find((item) => item.id === log.objectId);
    objectName = snapshot.name || targetUser?.name || snapshot.account || targetUser?.account || "用户";
    objectContext = snapshot.account || targetUser?.account || "";
  } else if (log.objectType === "relation") {
    const relation = snapshot.id ? snapshot : db.parentStudentRelations.find((item) => item.id === log.objectId) || {};
    const parent = db.users.find((item) => item.id === relation.parentUserId);
    objectName = `${parent?.name || "家长"}与${studentName || "学生"}的绑定关系`;
  }

  return {
    ...log,
    objectName: objectName || log.objectId,
    objectContext,
    studentName
  };
}

function operationLogForUser(db, log, user) {
  const decorated = decorateOperationLog(db, log);
  if (user.role === "admin") return decorated;
  const { ip, userAgent, beforeData, afterData, ...safe } = decorated;
  return safe;
}

function logOperation(db, req, user, action, objectType, objectId, beforeData, afterData, meta = {}) {
  db.operationLogs.unshift({
    id: id("log"),
    operatorUserId: user.id,
    operatorName: user.name,
    operatorRole: user.role,
    action,
    objectType,
    objectId,
    studentId: meta.studentId || null,
    date: meta.date || null,
    beforeData: beforeData || null,
    afterData: afterData || null,
    ip: req.socket.remoteAddress || "",
    userAgent: req.headers["user-agent"] || "",
    createdAt: now()
  });
}

function routeKey(method, pathname) {
  return `${method.toUpperCase()} ${pathname}`;
}

async function handleApi(req, res, pathname, searchParams, body = {}) {
  const db = await readDb();
  const key = routeKey(req.method, pathname);

  if (key === "POST /api/auth/register") {
    enforceAuthRateLimit(req);
    const account = textInput(body.account, "账号", 64, true);
    const password = String(body.password || "");
    const name = textInput(body.name, "姓名", 50, true);
    const role = String(body.role || "");
    validateNewPassword(password);
    if (!["teacher", "parent"].includes(role)) fail(400, "注册身份只能是教师或家长");
    if (db.users.some((item) => item.account === account)) fail(409, "账号已存在");
    const user = {
      id: id("usr"),
      account,
      passwordHash: hashPassword(password),
      name,
      phone: account,
      role,
      roles: [role],
      lastActiveRole: role,
      wechatOpenid: "",
      wechatUnionid: "",
      status: "active",
      createdAt: now(),
      updatedAt: now()
    };
    db.users.push(user);
    await writeDb(db);
    return send(res, 201, { user: cleanUser(user) });
  }

  if (key === "POST /api/auth/login") {
    enforceAuthRateLimit(req);
    const account = textInput(body.account, "账号", 64, true);
    const password = String(body.password || "");
    if (password.length > 128) fail(400, "密码不能超过 128 位");
    const user = db.users.find((item) => item.account === account && item.status === "active");
    if (!user || !verifyPassword(password, user.passwordHash)) fail(401, "账号或密码错误");
    if (passwordHashNeedsUpgrade(user.passwordHash)) user.passwordHash = hashPassword(password);
    const roles = userRoles(user);
    const requestedRole = String(body.role || "");
    const activeRole = roles.includes(requestedRole)
      ? requestedRole
      : roles.includes(user.lastActiveRole) ? user.lastActiveRole : roles[0];
    const token = crypto.randomBytes(32).toString("hex");
    db.sessions = db.sessions.filter((item) => item.userId !== user.id);
    db.sessions.push({ token, userId: user.id, activeRole, createdAt: now(), expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
    user.lastActiveRole = activeRole;
    await writeDb(db);
    return send(res, 200, { token, user: cleanUser({ ...user, role: activeRole, roles }) });
  }

  if (key === "POST /api/auth/logout") {
    const token = getToken(req);
    db.sessions = db.sessions.filter((item) => item.token !== token);
    await writeDb(db);
    return send(res, 200, { ok: true });
  }

  if (key === "GET /api/auth/me") {
    const user = requireUser(db, req);
    const classes = listClassesForUser(db, user);
    const students = user.role === "parent"
      ? db.parentStudentRelations
          .filter((rel) => rel.parentUserId === user.id)
          .map((rel) => db.students.find((student) => student.id === rel.studentId && student.status !== "removed"))
          .filter(Boolean)
      : [];
    return send(res, 200, { user: cleanUser(user), classes, students });
  }

  if (key === "POST /api/auth/roles") {
    const user = requireUser(db, req);
    if (user.role === "admin") fail(403, "管理员不能添加普通身份");
    const role = String(body.role || "");
    if (!["teacher", "parent"].includes(role)) fail(400, "身份无效");
    const storedUser = db.users.find((item) => item.id === user.id);
    const roles = userRoles(storedUser);
    if (roles.includes(role)) {
      return send(res, 200, { user: cleanUser({ ...storedUser, role: user.role, roles }), alreadyExists: true });
    }
    roles.push(role);
    storedUser.roles = roles;
    storedUser.updatedAt = now();
    logOperation(db, req, user, "add_user_role", "user", user.id, null, { role });
    await writeDb(db);
    return send(res, 200, { user: cleanUser({ ...storedUser, role: user.role, roles }) });
  }

  if (key === "POST /api/auth/switch-role") {
    const user = requireUser(db, req);
    if (user.role === "admin") fail(403, "管理员不能切换普通身份");
    const role = String(body.role || "");
    const storedUser = db.users.find((item) => item.id === user.id);
    const roles = userRoles(storedUser);
    if (!roles.includes(role)) fail(403, "尚未开通该身份");
    if (role === user.role) {
      return send(res, 200, { user: cleanUser({ ...storedUser, role, roles }), alreadyActive: true });
    }
    const session = db.sessions.find((item) => item.token === getToken(req));
    session.activeRole = role;
    storedUser.lastActiveRole = role;
    storedUser.updatedAt = now();
    logOperation(db, req, { ...user, role }, "switch_user_role", "user", user.id, { role: user.role }, { role });
    await writeDb(db);
    return send(res, 200, { user: cleanUser({ ...storedUser, role, roles }) });
  }

  const user = requireUser(db, req);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "")) {
    enforceActionRateLimit(req, user, "mutation", MUTATION_RATE_LIMIT_MAX);
  }

  if (key === "POST /api/classes") {
    requireRole(user, ["teacher", "admin"]);
    if (user.role === "teacher" && teacherClassIds(db, user.id).length >= MAX_CLASSES_PER_TEACHER) {
      fail(409, `每个教师最多管理 ${MAX_CLASSES_PER_TEACHER} 个班级`);
    }
    const className = textInput(body.className, "班级名称", 100, true);
    const classCode = makeClassCode(db);
    let teacherInviteCode = makeClassCode(db);
    while (teacherInviteCode === classCode) teacherInviteCode = makeClassCode(db);
    const classItem = {
      id: id("cls"),
      className,
      classCode,
      classCodeEnabled: true,
      teacherInviteCode,
      teacherInviteCodeEnabled: true,
      grade: textInput(body.grade, "年级", 50),
      status: "active",
      createdTeacherId: user.id,
      createdAt: now(),
      updatedAt: now()
    };
    db.classes.push(classItem);
    db.teacherClassRelations.push({
      id: id("tcr"),
      teacherUserId: user.id,
      classId: classItem.id,
      role: "owner",
      createdAt: now()
    });
    logOperation(db, req, user, "create_class", "class", classItem.id, null, classItem);
    await writeDb(db);
    return send(res, 201, { class: decorateClassForUser(db, classItem, user) });
  }

  if (key === "POST /api/classes/join-by-code") {
    requireRole(user, ["teacher", "admin"]);
    enforceActionRateLimit(req, user, "invite", INVITE_RATE_LIMIT_MAX);
    const classCode = textInput(body.classCode, "教师邀请码", 32, true).toUpperCase();
    const classItem = db.classes.find((item) => item.teacherInviteCode === classCode && item.teacherInviteCodeEnabled !== false && item.status === "active");
    if (!classItem) fail(404, "教师邀请码无效或已停用");
    let relation = teacherClassRelation(db, user.id, classItem.id);
    if (!relation) {
      if (user.role === "teacher" && teacherClassIds(db, user.id).length >= MAX_CLASSES_PER_TEACHER) {
        fail(409, `每个教师最多管理 ${MAX_CLASSES_PER_TEACHER} 个班级`);
      }
      relation = {
        id: id("tcr"),
        teacherUserId: user.id,
        classId: classItem.id,
        role: "teacher",
        createdAt: now()
      };
      db.teacherClassRelations.push(relation);
      logOperation(db, req, user, "join_class_by_code", "class", classItem.id, null, { class: classItem, relation });
      await writeDb(db);
    }
    return send(res, 201, { class: decorateClassForUser(db, classItem, user), relation });
  }

  if (key === "GET /api/classes") {
    return send(res, 200, { classes: listClassesForUser(db, user) });
  }

  if (key === "GET /api/users") {
    requireRole(user, ["admin"]);
    return send(res, 200, { users: db.users.map(cleanUser) });
  }

  const userStatus = pathname.match(/^\/api\/users\/([^/]+)\/status$/);
  if (req.method === "PATCH" && userStatus) {
    requireRole(user, ["admin"]);
    const target = db.users.find((item) => item.id === userStatus[1]);
    if (!target) fail(404, "用户不存在");
    if (target.id === user.id) fail(400, "不能停用当前登录管理员");
    if (!["active", "disabled"].includes(body.status)) fail(400, "用户状态无效");
    const status = body.status;
    const before = cleanUser(target);
    target.status = status;
    if (status === "disabled") db.sessions = db.sessions.filter((item) => item.userId !== target.id);
    target.updatedAt = now();
    logOperation(db, req, user, "update_user_status", "user", target.id, before, cleanUser(target));
    await writeDb(db);
    return send(res, 200, { user: cleanUser(target) });
  }

  const userPassword = pathname.match(/^\/api\/users\/([^/]+)\/password$/);
  if (req.method === "PATCH" && userPassword) {
    requireRole(user, ["admin"]);
    const target = db.users.find((item) => item.id === userPassword[1]);
    if (!target) fail(404, "用户不存在");
    const newPassword = String(body.newPassword || "");
    validateNewPassword(newPassword, "新密码");
    target.passwordHash = hashPassword(newPassword);
    target.updatedAt = now();
    db.sessions = db.sessions.filter((item) => item.userId !== target.id);
    logOperation(db, req, user, "reset_user_password", "user", target.id, null, {
      id: target.id,
      account: target.account,
      passwordResetAt: target.updatedAt
    });
    await writeDb(db);
    return send(res, 200, { user: cleanUser(target) });
  }

  const classCodeRefresh = pathname.match(/^\/api\/classes\/([^/]+)\/code\/refresh$/);
  if (req.method === "POST" && classCodeRefresh) {
    requireRole(user, ["teacher", "admin"]);
    const classItem = db.classes.find((item) => item.id === classCodeRefresh[1]);
    if (!classItem) fail(404, "班级不存在");
    if (!canManageClassSettings(db, user, classItem.id)) fail(403, "只有班级创建者可以刷新班级编号");
    const before = { ...classItem };
    classItem.classCode = makeClassCode(db);
    classItem.classCodeEnabled = true;
    classItem.updatedAt = now();
    logOperation(db, req, user, "refresh_class_code", "class", classItem.id, before, classItem);
    await writeDb(db);
    return send(res, 200, { class: decorateClassForUser(db, classItem, user) });
  }

  const classCodeDisable = pathname.match(/^\/api\/classes\/([^/]+)\/code\/disable$/);
  if (req.method === "POST" && classCodeDisable) {
    requireRole(user, ["teacher", "admin"]);
    const classItem = db.classes.find((item) => item.id === classCodeDisable[1]);
    if (!classItem) fail(404, "班级不存在");
    if (!canManageClassSettings(db, user, classItem.id)) fail(403, "只有班级创建者可以停用班级编号");
    const before = { ...classItem };
    classItem.classCodeEnabled = false;
    classItem.updatedAt = now();
    logOperation(db, req, user, "disable_class_code", "class", classItem.id, before, classItem);
    await writeDb(db);
    return send(res, 200, { class: decorateClassForUser(db, classItem, user) });
  }

  const teacherCodeRefresh = pathname.match(/^\/api\/classes\/([^/]+)\/teacher-code\/refresh$/);
  if (req.method === "POST" && teacherCodeRefresh) {
    requireRole(user, ["teacher", "admin"]);
    const classItem = db.classes.find((item) => item.id === teacherCodeRefresh[1]);
    if (!classItem) fail(404, "班级不存在");
    if (!canManageClassSettings(db, user, classItem.id)) fail(403, "只有班级创建者可以刷新教师邀请码");
    const before = { ...classItem };
    classItem.teacherInviteCode = makeClassCode(db);
    classItem.teacherInviteCodeEnabled = true;
    classItem.updatedAt = now();
    logOperation(db, req, user, "refresh_teacher_invite_code", "class", classItem.id, before, classItem);
    await writeDb(db);
    return send(res, 200, { class: decorateClassForUser(db, classItem, user) });
  }

  const teacherCodeDisable = pathname.match(/^\/api\/classes\/([^/]+)\/teacher-code\/disable$/);
  if (req.method === "POST" && teacherCodeDisable) {
    requireRole(user, ["teacher", "admin"]);
    const classItem = db.classes.find((item) => item.id === teacherCodeDisable[1]);
    if (!classItem) fail(404, "班级不存在");
    if (!canManageClassSettings(db, user, classItem.id)) fail(403, "只有班级创建者可以停用教师邀请码");
    const before = { ...classItem };
    classItem.teacherInviteCodeEnabled = false;
    classItem.updatedAt = now();
    logOperation(db, req, user, "disable_teacher_invite_code", "class", classItem.id, before, classItem);
    await writeDb(db);
    return send(res, 200, { class: decorateClassForUser(db, classItem, user) });
  }

  const classStudents = pathname.match(/^\/api\/classes\/([^/]+)\/students$/);
  if (req.method === "GET" && classStudents) {
    requireRole(user, ["teacher", "admin"]);
    const classId = classStudents[1];
    if (!canAccessClass(db, user, classId)) fail(403, "没有班级权限");
    const students = db.students
      .filter((item) => item.classId === classId && item.status !== "removed")
      .map((student) => ({
        ...student,
        parents: db.parentStudentRelations
          .filter((rel) => rel.studentId === student.id)
          .map((rel) => ({ ...rel, parent: publicUser(db.users.find((item) => item.id === rel.parentUserId), "parent") }))
      }));
    return send(res, 200, { students: decorateStudentsForTeacher(students, db) });
  }

  const removeStudent = pathname.match(/^\/api\/classes\/([^/]+)\/students\/([^/]+)$/);
  if (req.method === "DELETE" && removeStudent) {
    requireRole(user, ["teacher", "admin"]);
    const [_, classId, studentId] = removeStudent;
    if (!canAccessClass(db, user, classId)) fail(403, "没有班级权限");
    const student = db.students.find((item) => item.id === studentId && item.classId === classId);
    if (!student) fail(404, "学生不存在");
    const before = { ...student };
    student.status = "removed";
    student.updatedAt = now();
    logOperation(db, req, user, "remove_student", "student", student.id, before, student, { studentId });
    await writeDb(db);
    return send(res, 200, { student });
  }

  if (key === "POST /api/students/bind-by-class-code") {
    requireRole(user, ["parent"]);
    enforceActionRateLimit(req, user, "invite", INVITE_RATE_LIMIT_MAX);
    const classCode = textInput(body.classCode, "班级编号", 32, true).toUpperCase();
    const studentName = textInput(body.studentName, "学生姓名", 50, true);
    const studentNo = textInput(body.studentNo, "学号", 50);
    const remark = textInput(body.remark, "备注", 500);
    const relationType = textInput(body.relationType || "监护人", "关系", 30, true);
    const classItem = db.classes.find((item) => item.classCode === classCode && item.classCodeEnabled && item.status === "active");
    if (!classItem) fail(404, "班级编号无效或已停用");
    const parentStudentIds = db.parentStudentRelations
      .filter((item) => item.parentUserId === user.id)
      .map((item) => item.studentId);
    let student = db.students.find((item) =>
      parentStudentIds.includes(item.id) &&
      item.classId === classItem.id &&
      item.name === studentName &&
      (item.studentNo || "") === studentNo &&
      (item.remark || "") === remark &&
      item.status !== "removed"
    ) || null;
    let createdStudent = false;
    if (!student) {
      student = {
        id: id("stu"),
        name: studentName,
        gender: textInput(body.gender, "性别", 30),
        classId: classItem.id,
        studentNo,
        careCode: nextStudentCareCode(db, classItem.id, studentName),
        careCodeVersion: 2,
        remark,
        status: "active",
        createdAt: now(),
        updatedAt: now()
      };
      db.students.push(student);
      createdStudent = true;
    }
    let relation = db.parentStudentRelations.find((item) => item.parentUserId === user.id && item.studentId === student.id);
    const alreadyBound = Boolean(relation);
    if (!relation) {
      const activeRelations = db.parentStudentRelations.filter((item) => item.parentUserId === user.id &&
        db.students.some((studentItem) => studentItem.id === item.studentId && studentItem.status !== "removed"));
      if (activeRelations.length >= MAX_STUDENTS_PER_PARENT) {
        fail(409, `每个家长最多绑定 ${MAX_STUDENTS_PER_PARENT} 个孩子`);
      }
      relation = {
        id: id("psr"),
        parentUserId: user.id,
        studentId: student.id,
        relationType,
        isPrimary: true,
        source: "class_code",
        createdAt: now()
      };
      db.parentStudentRelations.push(relation);
      logOperation(db, req, user, "bind_student_by_class_code", "student", student.id, null, { student, relation }, { studentId: student.id });
    }
    await writeDb(db);
    return send(res, alreadyBound ? 200 : 201, {
      student,
      relation,
      class: parentClass(classItem),
      createdStudent,
      matchedExistingStudent: false,
      alreadyBound
    });
  }

  if (key === "GET /api/students") {
    if (user.role === "parent") {
      const students = db.parentStudentRelations
        .filter((rel) => rel.parentUserId === user.id)
        .map((rel) => db.students.find((student) => student.id === rel.studentId && student.status !== "removed"))
        .filter(Boolean)
        .map((student) => ({ ...student, class: parentClass(db.classes.find((item) => item.id === student.classId)) }));
      return send(res, 200, { students: decorateStudentsForTeacher(students, db) });
    }
    if (user.role === "teacher") {
      const classIds = teacherClassIds(db, user.id);
      const students = db.students.filter((item) => classIds.includes(item.classId) && item.status !== "removed");
      return send(res, 200, { students: decorateStudentsForTeacher(students, db) });
    }
    return send(res, 200, { students: decorateStudentsForTeacher(db.students.map((student) => decorateStudentForAdmin(student, db)), db) });
  }

  const studentStatus = pathname.match(/^\/api\/students\/([^/]+)\/status$/);
  if (req.method === "PATCH" && studentStatus) {
    requireRole(user, ["admin"]);
    const student = db.students.find((item) => item.id === studentStatus[1]);
    if (!student) fail(404, "学生不存在");
    if (!["active", "removed"].includes(body.status)) fail(400, "学生状态无效");
    const status = body.status;
    const before = { ...student };
    student.status = status;
    student.updatedAt = now();
    logOperation(db, req, user, "update_student_status", "student", student.id, before, student, { studentId: student.id });
    await writeDb(db);
    return send(res, 200, { student: decorateStudentForAdmin(student, db) });
  }

  const studentRemark = pathname.match(/^\/api\/students\/([^/]+)\/remark$/);
  if (req.method === "PATCH" && studentRemark) {
    requireRole(user, ["parent", "teacher", "admin"]);
    const student = db.students.find((item) => item.id === studentRemark[1] && item.status !== "removed");
    if (!student) fail(404, "学生不存在");
    if (!canAccessStudent(db, user, student.id)) fail(403, "没有学生权限");
    const remark = textInput(body.remark, "备注", 500);
    const before = { ...student };
    student.remark = remark;
    student.updatedAt = now();
    logOperation(db, req, user, "update_student_remark", "student", student.id, before, student, { studentId: student.id });
    await writeDb(db);
    return send(res, 200, { student });
  }

  if (key === "POST /api/parent-student-relations") {
    requireRole(user, ["admin"]);
    const parentAccount = String(body.parentAccount || "").trim();
    const studentId = String(body.studentId || "").trim();
    const relationType = String(body.relationType || "监护人").trim();
    if (!parentAccount || !studentId) fail(400, "家长账号和学生不能为空");
    const parent = db.users.find((item) => item.account === parentAccount && hasRole(item, "parent") && item.status === "active");
    if (!parent) fail(404, "家长账号不存在或不是启用状态");
    const student = db.students.find((item) => item.id === studentId);
    if (!student) fail(404, "学生不存在");
    const existing = db.parentStudentRelations.find((item) => item.parentUserId === parent.id && item.studentId === student.id);
    if (existing) fail(409, "该家长已经绑定该学生");
    const relation = {
      id: id("psr"),
      parentUserId: parent.id,
      studentId: student.id,
      relationType,
      isPrimary: false,
      source: "admin",
      createdAt: now()
    };
    db.parentStudentRelations.push(relation);
    logOperation(db, req, user, "create_parent_student_relation", "relation", relation.id, null, relation, { studentId: student.id });
    await writeDb(db);
    return send(res, 201, { relation: decorateParentStudentRelation(relation, db) });
  }

  if (key === "GET /api/parent-student-relations") {
    requireRole(user, ["admin"]);
    return send(res, 200, {
      relations: db.parentStudentRelations.map((relation) => decorateParentStudentRelation(relation, db))
    });
  }

  const deleteRelation = pathname.match(/^\/api\/parent-student-relations\/([^/]+)$/);
  if (req.method === "DELETE" && deleteRelation) {
    requireRole(user, ["teacher", "admin"]);
    const relation = db.parentStudentRelations.find((item) => item.id === deleteRelation[1]);
    if (!relation) fail(404, "绑定关系不存在");
    const student = db.students.find((item) => item.id === relation.studentId);
    if (!student || !canAccessStudent(db, user, student.id)) fail(403, "没有学生权限");
    db.parentStudentRelations = db.parentStudentRelations.filter((item) => item.id !== relation.id);
    logOperation(db, req, user, "unbind_parent_student", "relation", relation.id, relation, null, { studentId: relation.studentId });
    await writeDb(db);
    return send(res, 200, { ok: true });
  }

  if (key === "GET /api/attendance") {
    const studentId = searchParams.get("studentId");
    const date = normalizeDate(searchParams.get("date"));
    if (!studentId) fail(400, "studentId 不能为空");
    if (!canAccessStudent(db, user, studentId)) fail(403, "没有学生权限");
    const attendance = db.attendanceRecords.find((item) => item.studentId === studentId && item.date === date) || null;
    return send(res, 200, { attendance });
  }

  if (key === "PUT /api/attendance") {
    const studentId = String(body.studentId || "");
    const date = normalizeDate(body.date);
    if (!studentId) fail(400, "studentId 不能为空");
    requireRole(user, ["parent", "teacher", "admin"]);
    if (!canAccessStudent(db, user, studentId)) fail(403, "没有学生权限");
    if (!["normal", "leave"].includes(body.morningStatus) || !["normal", "leave"].includes(body.afternoonStatus)) {
      fail(400, "出勤状态无效");
    }
    const payload = {
      morningStatus: body.morningStatus,
      afternoonStatus: body.afternoonStatus,
      morningRemark: textInput(body.morningRemark, "上午备注", 500),
      afternoonRemark: textInput(body.afternoonRemark, "下午备注", 500)
    };
    let attendance = db.attendanceRecords.find((item) => item.studentId === studentId && item.date === date);
    const before = attendance ? { ...attendance } : null;
    if (!attendance) {
      attendance = {
        id: id("att"),
        studentId,
        date,
        createdBy: user.id,
        createdByRole: user.role,
        lastModifiedBy: user.id,
        lastModifiedByRole: user.role,
        createdAt: now(),
        updatedAt: now(),
        ...payload
      };
      db.attendanceRecords.push(attendance);
    } else {
      Object.assign(attendance, payload, { lastModifiedBy: user.id, lastModifiedByRole: user.role, updatedAt: now() });
    }
    logOperation(db, req, user, before ? "update_attendance" : "create_attendance", "attendance", attendance.id, before, attendance, { studentId, date });
    await writeDb(db);
    return send(res, 200, { attendance });
  }

  if (key === "GET /api/tasks") {
    const studentId = searchParams.get("studentId");
    const date = normalizeDate(searchParams.get("date"));
    if (!studentId) fail(400, "studentId 不能为空");
    if (!canAccessStudent(db, user, studentId)) fail(403, "没有学生权限");
    const tasks = db.dailyTasks
      .filter((item) => item.studentId === studentId && item.date === date && !item.deleted)
      .map((task) => decorateTask(db, task));
    return send(res, 200, { tasks });
  }

  if (key === "POST /api/tasks") {
    requireRole(user, ["parent", "teacher", "admin"]);
    const studentId = String(body.studentId || "");
    const date = normalizeDate(body.date);
    const title = textInput(body.title, "任务标题", 200, true);
    if (!studentId) fail(400, "学生不能为空");
    if (!canAccessStudent(db, user, studentId)) fail(403, "没有学生权限");
    const taskCount = db.dailyTasks.filter((item) => item.studentId === studentId && item.date === date && !item.deleted).length;
    if (taskCount >= MAX_TASKS_PER_STUDENT_DATE) fail(409, `每名学生每天最多创建 ${MAX_TASKS_PER_STUDENT_DATE} 条任务`);
    const task = {
      id: id("tsk"),
      studentId,
      date,
      title,
      content: textInput(body.content, "任务内容", 2000),
      teacherRemark: "",
      teacherRemarkBy: null,
      teacherRemarkByRole: null,
      teacherRemarkAt: null,
      status: "pending",
      completed: false,
      createdBy: user.id,
      createdByRole: user.role,
      lastModifiedBy: user.id,
      lastModifiedByRole: user.role,
      completedBy: null,
      completedByRole: null,
      completedAt: null,
      deleted: false,
      createdAt: now(),
      updatedAt: now()
    };
    db.dailyTasks.push(task);
    logOperation(db, req, user, "create_task", "task", task.id, null, task, { studentId, date });
    await writeDb(db);
    return send(res, 201, { task: decorateTask(db, task) });
  }

  const taskById = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskById && req.method === "PUT") {
    requireRole(user, ["parent", "teacher", "admin"]);
    const task = db.dailyTasks.find((item) => item.id === taskById[1] && !item.deleted);
    if (!task) fail(404, "任务不存在");
    if (!canAccessStudent(db, user, task.studentId)) fail(403, "没有学生权限");
    if (!canManageOwnTask(db, user, task)) fail(403, "只能修改当前身份创建的任务");
    if (user.role !== "admin" && taskStatus(task) === "completed") fail(403, "已完成任务不能修改");
    const title = textInput(body.title, "任务标题", 200, true);
    const before = { ...task };
    task.title = title;
    task.content = textInput(body.content ?? task.content, "任务内容", 2000);
    task.lastModifiedBy = user.id;
    task.lastModifiedByRole = user.role;
    task.updatedAt = now();
    logOperation(db, req, user, "update_task", "task", task.id, before, task, { studentId: task.studentId, date: task.date });
    await writeDb(db);
    return send(res, 200, { task: decorateTask(db, task) });
  }

  const taskTeacherRemark = pathname.match(/^\/api\/tasks\/([^/]+)\/teacher-remark$/);
  if (taskTeacherRemark && req.method === "PATCH") {
    requireRole(user, ["teacher", "admin"]);
    const task = db.dailyTasks.find((item) => item.id === taskTeacherRemark[1] && !item.deleted);
    if (!task) fail(404, "任务不存在");
    if (!canAccessStudent(db, user, task.studentId)) fail(403, "没有学生权限");
    const before = { ...task };
    task.teacherRemark = textInput(body.teacherRemark, "教师批注", 2000);
    task.teacherRemarkBy = task.teacherRemark ? user.id : null;
    task.teacherRemarkByRole = task.teacherRemark ? user.role : null;
    task.teacherRemarkAt = task.teacherRemark ? now() : null;
    task.lastModifiedBy = user.id;
    task.lastModifiedByRole = user.role;
    task.updatedAt = now();
    logOperation(db, req, user, "update_task_teacher_remark", "task", task.id, before, task, { studentId: task.studentId, date: task.date });
    await writeDb(db);
    return send(res, 200, { task: decorateTask(db, task) });
  }

  if (taskById && req.method === "DELETE") {
    requireRole(user, ["parent", "teacher", "admin"]);
    const task = db.dailyTasks.find((item) => item.id === taskById[1] && !item.deleted);
    if (!task) fail(404, "任务不存在");
    if (!canAccessStudent(db, user, task.studentId)) fail(403, "没有学生权限");
    if (!canManageOwnTask(db, user, task)) fail(403, "只能删除当前身份创建的任务");
    if (user.role !== "admin" && taskStatus(task) === "completed") fail(403, "已完成任务不能删除");
    const before = { ...task };
    task.deleted = true;
    task.lastModifiedBy = user.id;
    task.lastModifiedByRole = user.role;
    task.updatedAt = now();
    logOperation(db, req, user, "delete_task", "task", task.id, before, task, { studentId: task.studentId, date: task.date });
    await writeDb(db);
    return send(res, 200, { task: decorateTask(db, task) });
  }

  const taskCompletion = pathname.match(/^\/api\/tasks\/([^/]+)\/completion$/);
  if (taskCompletion && req.method === "PATCH") {
    requireRole(user, ["teacher", "admin"]);
    const task = db.dailyTasks.find((item) => item.id === taskCompletion[1] && !item.deleted);
    if (!task) fail(404, "任务不存在");
    if (!canAccessStudent(db, user, task.studentId)) fail(403, "没有学生权限");
    const before = { ...task };
    if (body.status !== undefined && !["pending", "completed"].includes(body.status)) fail(400, "任务状态无效");
    if (body.status === undefined && typeof body.completed !== "boolean") fail(400, "任务状态无效");
    const status = body.status || (body.completed ? "completed" : "pending");
    task.status = status;
    task.completed = status === "completed";
    task.completedBy = task.completed ? user.id : null;
    task.completedByRole = task.completed ? user.role : null;
    task.completedAt = task.completed ? now() : null;
    task.lastModifiedBy = user.id;
    task.lastModifiedByRole = user.role;
    task.updatedAt = now();
    logOperation(db, req, user, task.completed ? "complete_task" : "mark_task_pending", "task", task.id, before, task, { studentId: task.studentId, date: task.date });
    await writeDb(db);
    return send(res, 200, { task: decorateTask(db, task) });
  }

  if (key === "GET /api/operation-logs/archive") {
    requireRole(user, ["admin"]);
    const startDate = String(searchParams.get("startDate") || "");
    const endDate = String(searchParams.get("endDate") || "");
    if (startDate) normalizeDate(startDate);
    if (endDate) normalizeDate(endDate);
    const startValue = startDate ? new Date(`${startDate}T00:00:00.000+08:00`) : new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const endValue = endDate ? new Date(`${endDate}T23:59:59.999+08:00`) : new Date();
    if (Number.isNaN(startValue.getTime()) || Number.isNaN(endValue.getTime())) fail(400, "日期无效");
    const startAt = startValue.toISOString();
    const endAt = endValue.toISOString();
    if (startAt > endAt) fail(400, "开始日期不能晚于结束日期");
    const requestedLimit = Number(searchParams.get("limit"));
    const requestedOffset = Number(searchParams.get("offset"));
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(Math.floor(requestedLimit), 100) : 50;
    const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.floor(requestedOffset) : 0;
    const database = openDatabase();
    const total = database
      .prepare("SELECT COUNT(*) AS count FROM operation_log_archive WHERE created_at >= ? AND created_at <= ?")
      .get(startAt, endAt).count;
    const rows = database
      .prepare("SELECT data FROM operation_log_archive WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(startAt, endAt, limit, offset);
    return send(res, 200, {
      logs: rows.map((row) => decorateOperationLog(db, JSON.parse(row.data))),
      startDate: startAt,
      endDate: endAt,
      retentionDays: LOG_RETENTION_DAYS,
      total,
      offset,
      nextOffset: offset + rows.length,
      hasMore: offset + rows.length < total
    });
  }

  if (key === "GET /api/operation-logs") {
    const studentId = searchParams.get("studentId");
    let logs = db.operationLogs;
    if (studentId) logs = logs.filter((item) => item.studentId === studentId);
    if (user.role !== "admin") {
      logs = logs.filter((item) =>
        (item.operatorUserId === user.id && item.operatorRole === user.role) ||
        (item.studentId && canAccessStudent(db, user, item.studentId))
      );
    }
    logs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const requestedOffset = Number(searchParams.get("offset"));
    const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.floor(requestedOffset) : 0;
    const requestedLimit = Number(searchParams.get("limit"));
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(Math.floor(requestedLimit), 100) : 200;
    const page = logs.slice(offset, offset + limit);
    return send(res, 200, {
      logs: page.map((log) => operationLogForUser(db, log, user)),
      hotDays: LOG_HOT_DAYS,
      total: logs.length,
      offset,
      nextOffset: offset + page.length,
      hasMore: offset + page.length < logs.length
    });
  }

  fail(404, "接口不存在");
}

async function serveStatic(req, res, pathname) {
  const filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname);
  const normalized = path.normalize(filePath);
  if (normalized !== PUBLIC_DIR && !normalized.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8" });
  }
  try {
    const content = await readFile(normalized);
    const contentType = staticTypes[path.extname(normalized)] || "application/octet-stream";
    res.writeHead(200, { ...securityHeaders, "content-type": contentType });
    res.end(content);
  } catch {
    send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
  }
}

let apiQueue = Promise.resolve();

function serializeApi(work) {
  const result = apiQueue.then(work, work);
  apiQueue = result.catch(() => {});
  return result;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      const body = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "") ? await readBody(req) : {};
      const run = () => handleApi(req, res, url.pathname, url.searchParams, body);
      await serializeApi(run);
      return;
    }
    await serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(`[${req.method || "UNKNOWN"}] ${req.url || "/"}`, error);
    send(res, status, { error: status >= 500 ? "服务器错误" : error.message || "请求失败" });
  }
});

await ensureDb();
maintainOperationLogs(openDatabase());
await initConfiguredAdmin();
server.listen(PORT, HOST, () => {
  console.log(`Student care system running at http://${HOST}:${PORT}`);
});
