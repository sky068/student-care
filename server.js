import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, ".env"));

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "stumng.sqlite");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
const ADMIN_ACCOUNT = process.env.ADMIN_ACCOUNT || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_NAME = process.env.ADMIN_NAME || "系统管理员";

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

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
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
  `);
}

async function readDb() {
  await ensureDb();
  const db = Object.fromEntries(Object.keys(initialDb).map((key) => [key, []]));
  const rows = openDatabase().prepare("SELECT collection, data FROM app_records").all();
  for (const row of rows) {
    if (!db[row.collection]) db[row.collection] = [];
    db[row.collection].push(JSON.parse(row.data));
  }
  if (ensureStudentCareCodes(db)) persistDb(openDatabase(), db);
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
  const existing = db.users.find((item) => item.account === ADMIN_ACCOUNT);
  if (existing) {
    existing.name = ADMIN_NAME;
    existing.phone = ADMIN_ACCOUNT;
    existing.role = "admin";
    existing.passwordHash = hashPassword(ADMIN_PASSWORD);
    existing.status = "active";
    existing.updatedAt = now();
  } else {
    db.users.push({
      id: id("usr"),
      account: ADMIN_ACCOUNT,
      passwordHash: hashPassword(ADMIN_PASSWORD),
      name: ADMIN_NAME,
      phone: ADMIN_ACCOUNT,
      role: "admin",
      wechatOpenid: "",
      wechatUnionid: "",
      status: "active",
      createdAt: now(),
      updatedAt: now()
    });
  }
  await writeDb(db);
  console.log(`Configured admin ready: ${ADMIN_ACCOUNT}`);
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

function now() {
  return new Date().toISOString();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt] = stored.split(":");
  return hashPassword(password, salt) === stored;
}

function normalizeDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function cleanUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

function makeClassCode(db) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = "";
    for (let i = 0; i < 6; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    if (!db.classes.some((item) => item.classCode === code)) return code;
  }
  throw Object.assign(new Error("班级编号生成失败"), { status: 500 });
}

function send(res, status, body, headers = jsonHeaders) {
  res.writeHead(status, headers);
  res.end(headers["content-type"]?.includes("application/json") ? JSON.stringify(body) : body);
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  return db.users.find((item) => item.id === session.userId && item.status === "active") || null;
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
  if (user.role === "parent") {
    return db.parentStudentRelations.some((item) => item.parentUserId === user.id && item.studentId === studentId);
  }
  if (user.role === "teacher") {
    const classIds = teacherClassIds(db, user.id);
    return db.students.some((item) => item.id === studentId && classIds.includes(item.classId));
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
      teacher: cleanUser(db.users.find((item) => item.id === relation.teacherUserId)),
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
    const sameStudentNoCount = student.studentNo
      ? group.filter((item) => item.studentNo === student.studentNo).length
      : 0;
    let identifier = student.studentNo || "";
    if (duplicateCount > 1 && (!student.studentNo || sameStudentNoCount > 1)) {
      identifier = student.studentNo ? `${student.studentNo} · ${student.careCode}` : student.careCode;
    }
    return {
      ...student,
      displayName: identifier ? `${student.name}（${identifier}）` : student.name,
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

function taskActor(db, userId, fallbackLog = null) {
  const user = db.users.find((item) => item.id === userId);
  if (!user && !fallbackLog) return null;
  return {
    id: user?.id || userId || fallbackLog.operatorUserId,
    name: user?.name || fallbackLog.operatorName || "未知用户",
    role: user?.role || fallbackLog.operatorRole || ""
  };
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
  return {
    ...task,
    status,
    completed: status === "completed",
    lastModifiedBy,
    createdByUser: taskActor(db, task.createdBy, createLog),
    lastModifiedByUser: taskActor(db, lastModifiedBy, latestLog),
    completedByUser: task.completedBy ? taskActor(db, task.completedBy, completionLog) : null
  };
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

async function handleApi(req, res, pathname, searchParams) {
  const db = await readDb();
  const body = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "") ? await readBody(req) : {};
  const key = routeKey(req.method, pathname);

  if (key === "POST /api/auth/register") {
    const account = String(body.account || "").trim();
    const password = String(body.password || "");
    const name = String(body.name || "").trim();
    const role = String(body.role || "");
    if (!account || !password || !name) fail(400, "账号、密码和姓名不能为空");
    if (!["teacher", "parent"].includes(role)) fail(400, "注册身份只能是教师或家长");
    if (db.users.some((item) => item.account === account)) fail(409, "账号已存在");
    const user = {
      id: id("usr"),
      account,
      passwordHash: hashPassword(password),
      name,
      phone: account,
      role,
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
    const account = String(body.account || "").trim();
    const password = String(body.password || "");
    const user = db.users.find((item) => item.account === account && item.status === "active");
    if (!user || !verifyPassword(password, user.passwordHash)) fail(401, "账号或密码错误");
    const token = crypto.randomBytes(32).toString("hex");
    db.sessions = db.sessions.filter((item) => item.userId !== user.id);
    db.sessions.push({ token, userId: user.id, createdAt: now() });
    await writeDb(db);
    return send(res, 200, { token, user: cleanUser(user) });
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
          .map((rel) => db.students.find((student) => student.id === rel.studentId))
          .filter(Boolean)
      : [];
    return send(res, 200, { user: cleanUser(user), classes, students });
  }

  const user = requireUser(db, req);

  if (key === "POST /api/classes") {
    requireRole(user, ["teacher", "admin"]);
    const className = String(body.className || "").trim();
    if (!className) fail(400, "班级名称不能为空");
    const classItem = {
      id: id("cls"),
      className,
      classCode: makeClassCode(db),
      classCodeEnabled: true,
      grade: String(body.grade || "").trim(),
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
    const classCode = String(body.classCode || "").trim().toUpperCase();
    if (!classCode) fail(400, "班级编号不能为空");
    const classItem = db.classes.find((item) => item.classCode === classCode && item.classCodeEnabled && item.status === "active");
    if (!classItem) fail(404, "班级编号无效或已停用");
    let relation = teacherClassRelation(db, user.id, classItem.id);
    if (!relation) {
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
    const status = body.status === "disabled" ? "disabled" : "active";
    const before = cleanUser(target);
    target.status = status;
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
    if (newPassword.length < 6) fail(400, "新密码至少需要 6 位");
    if (newPassword.length > 128) fail(400, "新密码不能超过 128 位");
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
          .map((rel) => ({ ...rel, parent: cleanUser(db.users.find((item) => item.id === rel.parentUserId)) }))
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
    requireRole(user, ["parent", "admin"]);
    const classCode = String(body.classCode || "").trim().toUpperCase();
    const studentName = String(body.studentName || "").trim();
    const studentNo = String(body.studentNo || "").trim();
    const relationType = String(body.relationType || "监护人").trim();
    if (!classCode || !studentName) fail(400, "班级编号和学生姓名不能为空");
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
      item.status !== "removed"
    ) || null;
    let createdStudent = false;
    if (!student) {
      student = {
        id: id("stu"),
        name: studentName,
        gender: String(body.gender || "").trim(),
        classId: classItem.id,
        studentNo,
        careCode: nextStudentCareCode(db, classItem.id, studentName),
        careCodeVersion: 2,
        remark: String(body.remark || "").trim(),
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
      class: classItem,
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
        .map((student) => ({ ...student, class: db.classes.find((item) => item.id === student.classId) }));
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
    const status = body.status === "removed" ? "removed" : "active";
    const before = { ...student };
    student.status = status;
    student.updatedAt = now();
    logOperation(db, req, user, "update_student_status", "student", student.id, before, student, { studentId: student.id });
    await writeDb(db);
    return send(res, 200, { student: decorateStudentForAdmin(student, db) });
  }

  if (key === "POST /api/parent-student-relations") {
    requireRole(user, ["admin"]);
    const parentAccount = String(body.parentAccount || "").trim();
    const studentId = String(body.studentId || "").trim();
    const relationType = String(body.relationType || "监护人").trim();
    if (!parentAccount || !studentId) fail(400, "家长账号和学生不能为空");
    const parent = db.users.find((item) => item.account === parentAccount && item.role === "parent" && item.status === "active");
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
    const payload = {
      morningStatus: body.morningStatus === "leave" ? "leave" : "normal",
      afternoonStatus: body.afternoonStatus === "leave" ? "leave" : "normal",
      morningRemark: String(body.morningRemark || "").trim(),
      afternoonRemark: String(body.afternoonRemark || "").trim()
    };
    let attendance = db.attendanceRecords.find((item) => item.studentId === studentId && item.date === date);
    const before = attendance ? { ...attendance } : null;
    if (!attendance) {
      attendance = {
        id: id("att"),
        studentId,
        date,
        createdBy: user.id,
        lastModifiedBy: user.id,
        createdAt: now(),
        updatedAt: now(),
        ...payload
      };
      db.attendanceRecords.push(attendance);
    } else {
      Object.assign(attendance, payload, { lastModifiedBy: user.id, updatedAt: now() });
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
    if (!studentId || !String(body.title || "").trim()) fail(400, "学生和任务标题不能为空");
    if (!canAccessStudent(db, user, studentId)) fail(403, "没有学生权限");
    const task = {
      id: id("tsk"),
      studentId,
      date,
      title: String(body.title).trim(),
      content: String(body.content || "").trim(),
      teacherRemark: "",
      teacherRemarkBy: null,
      teacherRemarkAt: null,
      status: "pending",
      completed: false,
      createdBy: user.id,
      lastModifiedBy: user.id,
      completedBy: null,
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
    if (user.role !== "admin" && task.createdBy !== user.id) fail(403, "只能修改自己创建的任务");
    if (user.role !== "admin" && taskStatus(task) === "completed") fail(403, "已完成任务不能修改");
    const title = String(body.title ?? "").trim();
    if (!title) fail(400, "任务标题不能为空");
    const before = { ...task };
    task.title = title;
    task.content = String(body.content ?? task.content).trim();
    task.lastModifiedBy = user.id;
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
    task.teacherRemark = String(body.teacherRemark || "").trim();
    task.teacherRemarkBy = task.teacherRemark ? user.id : null;
    task.teacherRemarkAt = task.teacherRemark ? now() : null;
    task.lastModifiedBy = user.id;
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
    if (user.role !== "admin" && task.createdBy !== user.id) fail(403, "只能删除自己创建的任务");
    if (user.role !== "admin" && taskStatus(task) === "completed") fail(403, "已完成任务不能删除");
    const before = { ...task };
    task.deleted = true;
    task.lastModifiedBy = user.id;
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
    const status = body.status === "completed" || body.completed === true ? "completed" : "pending";
    task.status = status;
    task.completed = status === "completed";
    task.completedBy = task.completed ? user.id : null;
    task.completedAt = task.completed ? now() : null;
    task.lastModifiedBy = user.id;
    task.updatedAt = now();
    logOperation(db, req, user, task.completed ? "complete_task" : "mark_task_pending", "task", task.id, before, task, { studentId: task.studentId, date: task.date });
    await writeDb(db);
    return send(res, 200, { task: decorateTask(db, task) });
  }

  if (key === "GET /api/operation-logs") {
    const studentId = searchParams.get("studentId");
    let logs = db.operationLogs;
    if (studentId) logs = logs.filter((item) => item.studentId === studentId);
    if (user.role !== "admin") {
      logs = logs.filter((item) => !item.studentId || canAccessStudent(db, user, item.studentId) || item.operatorUserId === user.id);
    }
    return send(res, 200, { logs: logs.slice(0, 200) });
  }

  fail(404, "接口不存在");
}

async function serveStatic(req, res, pathname) {
  const filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname);
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8" });
  try {
    const content = await readFile(normalized);
    const contentType = staticTypes[path.extname(normalized)] || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType });
    res.end(content);
  } catch {
    send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname, url.searchParams);
      return;
    }
    await serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (error) {
    const status = error.status || 500;
    send(res, status, { error: error.message || "服务器错误" });
  }
});

await ensureDb();
await initConfiguredAdmin();
server.listen(PORT, () => {
  console.log(`Student care system running at http://127.0.0.1:${PORT}`);
});
