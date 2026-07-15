import { mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

process.umask(0o077);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const dbFile = path.join(dataDir, "stumng.sqlite");

const now = () => new Date().toISOString();

const collections = [
  "users",
  "sessions",
  "classes",
  "students",
  "parentStudentRelations",
  "teacherClassRelations",
  "attendanceRecords",
  "dailyTasks",
  "operationLogs"
];

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const iterations = 600000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

function ensureSchema(db) {
  db.exec(`
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

function readStore(db) {
  const store = Object.fromEntries(collections.map((collection) => [collection, []]));
  const rows = db.prepare("SELECT collection, data FROM app_records").all();
  for (const row of rows) {
    if (!store[row.collection]) store[row.collection] = [];
    store[row.collection].push(JSON.parse(row.data));
  }
  return store;
}

function writeStore(db, store) {
  const removeCollection = db.prepare("DELETE FROM app_records WHERE collection = ?");
  const replace = db.prepare(`
    INSERT INTO app_records (collection, id, data, updated_at)
    VALUES (@collection, @id, @data, @updatedAt)
    ON CONFLICT(collection, id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction(() => {
    for (const collection of collections) {
      removeCollection.run(collection);
      for (const item of store[collection] || []) {
        replace.run({
          collection,
          id: item.id || item.token,
          data: JSON.stringify(item),
          updatedAt: now()
        });
      }
    }
  });
  tx();
}

function upsertUser(store, account, name, role) {
  let user = store.users.find((item) => item.account === account);
  if (!user) {
    user = {
      id: id("usr"),
      account,
      passwordHash: hashPassword("Test!1234"),
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
    store.users.push(user);
  } else {
    user.name = name;
    if (!["teacher", "parent"].includes(user.role)) user.role = role;
    const roles = Array.isArray(user.roles) ? user.roles.filter((item) => ["teacher", "parent"].includes(item)) : [user.role];
    user.roles = [...new Set([...roles, role])];
    if (!user.roles.includes(user.lastActiveRole)) user.lastActiveRole = user.role;
    user.status = "active";
    user.updatedAt = now();
  }
  return user;
}

function upsertById(collection, item) {
  const index = collection.findIndex((current) => current.id === item.id);
  if (index === -1) {
    collection.push(item);
    return item;
  }
  collection[index] = { ...collection[index], ...item, updatedAt: now() };
  return collection[index];
}

mkdirSync(dataDir, { recursive: true });
const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
ensureSchema(db);

const store = readStore(db);
const ownerTeacher = upsertUser(store, "teacher_owner_test", "测试创建教师", "teacher");
const helperTeacher = upsertUser(store, "teacher_helper_test", "测试协同教师", "teacher");
const firstParent = upsertUser(store, "parent_one_test", "测试家长一", "parent");
const secondParent = upsertUser(store, "parent_two_test", "测试家长二", "parent");

const classItem = upsertById(store.classes, {
  id: "cls_test_001",
  className: "测试一班",
  classCode: "TEST01",
  classCodeEnabled: true,
  teacherInviteCode: "TEACH1",
  teacherInviteCodeEnabled: true,
  grade: "",
  status: "active",
  createdTeacherId: ownerTeacher.id,
  createdAt: now(),
  updatedAt: now()
});

upsertById(store.teacherClassRelations, {
  id: "tcr_test_owner",
  teacherUserId: ownerTeacher.id,
  classId: classItem.id,
  role: "owner",
  createdAt: now()
});
upsertById(store.teacherClassRelations, {
  id: "tcr_test_helper",
  teacherUserId: helperTeacher.id,
  classId: classItem.id,
  role: "teacher",
  createdAt: now()
});

const studentSpecs = [
  { id: "stu_test_001", parent: firstParent, name: "多多", studentNo: "P1001", careCode: "01", remark: "测试家长一的同名孩子" },
  { id: "stu_test_002", parent: firstParent, name: "小雨", studentNo: "P1002", careCode: "01", remark: "测试家长一的孩子" },
  { id: "stu_test_003", parent: secondParent, name: "多多", studentNo: "P2001", careCode: "02", remark: "测试家长二的同名孩子" },
  { id: "stu_test_004", parent: secondParent, name: "小禾", studentNo: "P2002", careCode: "01", remark: "测试家长二的孩子" }
];

for (const spec of studentSpecs) {
  const student = upsertById(store.students, {
    id: spec.id,
    name: spec.name,
    gender: "",
    classId: classItem.id,
    studentNo: spec.studentNo,
    careCode: spec.careCode,
    careCodeVersion: 2,
    remark: spec.remark,
    status: "active",
    createdAt: now(),
    updatedAt: now()
  });

  upsertById(store.parentStudentRelations, {
    id: `psr_${student.id}`,
    parentUserId: spec.parent.id,
    studentId: student.id,
    relationType: "监护人",
    isPrimary: true,
    source: "seed",
    createdAt: now()
  });

  const taskDate = new Date().toISOString().slice(0, 10);
  const tasks = [
    { id: `tsk_${student.id}_001`, title: "阅读 20 分钟", content: "完成课外阅读并口头复述" },
    { id: `tsk_${student.id}_002`, title: "数学练习", content: "完成 10 道计算题" }
  ];
  for (const task of tasks) {
    upsertById(store.dailyTasks, {
      id: task.id,
      studentId: student.id,
      date: taskDate,
      title: task.title,
      content: task.content,
      teacherRemark: "",
      teacherRemarkBy: null,
      teacherRemarkByRole: null,
      teacherRemarkAt: null,
      status: "pending",
      completed: false,
      createdBy: spec.parent.id,
      createdByRole: "parent",
      lastModifiedBy: spec.parent.id,
      lastModifiedByRole: "parent",
      completedBy: null,
      completedByRole: null,
      completedAt: null,
      deleted: false,
      createdAt: now(),
      updatedAt: now()
    });
  }
}

writeStore(db, store);

console.log("测试数据已创建：");
console.log("- 创建教师：teacher_owner_test / Test!1234");
console.log("- 协同教师：teacher_helper_test / Test!1234");
console.log("- 家长一：parent_one_test / Test!1234");
console.log("- 家长二：parent_two_test / Test!1234");
console.log("- 班级：测试一班，班级编号 TEST01");
console.log("- 家长一的孩子：多多、小雨");
console.log("- 家长二的孩子：多多、小禾");
console.log("- 两名多多用于验证班级内重名标识");
console.log("- 每个孩子各 2 条待完成任务");
