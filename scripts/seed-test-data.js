import { mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

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
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
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
      passwordHash: hashPassword("test123456"),
      name,
      phone: account,
      role,
      wechatOpenid: "",
      wechatUnionid: "",
      status: "active",
      createdAt: now(),
      updatedAt: now()
    };
    store.users.push(user);
  } else {
    user.name = name;
    user.role = role;
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
const teacher = upsertUser(store, "teacher_test", "测试教师", "teacher");
const parent = upsertUser(store, "parent_test", "测试家长", "parent");

const classItem = upsertById(store.classes, {
  id: "cls_test_001",
  className: "测试一班",
  classCode: "TEST01",
  classCodeEnabled: true,
  grade: "",
  status: "active",
  createdTeacherId: teacher.id,
  createdAt: now(),
  updatedAt: now()
});

if (!store.teacherClassRelations.some((item) => item.teacherUserId === teacher.id && item.classId === classItem.id)) {
  store.teacherClassRelations.push({
    id: "tcr_test_001",
    teacherUserId: teacher.id,
    classId: classItem.id,
    role: "owner",
    createdAt: now()
  });
}

const studentSpecs = [
  { id: "stu_test_001", name: "测试学生一", studentNo: "S001", careCode: "01" },
  { id: "stu_test_002", name: "测试学生二", studentNo: "S002", careCode: "01" }
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
    remark: "测试数据",
    status: "active",
    createdAt: now(),
    updatedAt: now()
  });

  if (!store.parentStudentRelations.some((item) => item.parentUserId === parent.id && item.studentId === student.id)) {
    store.parentStudentRelations.push({
      id: `psr_${student.id}`,
      parentUserId: parent.id,
      studentId: student.id,
      relationType: "监护人",
      isPrimary: true,
      source: "seed",
      createdAt: now()
    });
  }

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
      status: "pending",
      completed: false,
      createdBy: parent.id,
      lastModifiedBy: parent.id,
      completedBy: null,
      completedAt: null,
      deleted: false,
      createdAt: now(),
      updatedAt: now()
    });
  }
}

writeStore(db, store);

console.log("测试数据已创建：");
console.log("- 教师账号：teacher_test / test123456");
console.log("- 家长账号：parent_test / test123456");
console.log("- 班级：测试一班，班级编号 TEST01");
console.log("- 学生：测试学生一、测试学生二");
console.log("- 每个学生各 2 条待完成任务");
