const app = document.querySelector("#app");

const state = {
  token: localStorage.getItem("stm_token") || "",
  user: null,
  classes: [],
  students: [],
  selectedClassId: "",
  selectedStudentId: "",
  parentOnboardingDismissed: false,
  date: new Date().toISOString().slice(0, 10),
  tasks: [],
  attendance: null,
  logs: [],
  adminTab: "users",
  adminUserRoleFilter: "all",
  adminStudentFilter: "all",
  adminData: {
    users: [],
    classes: [],
    students: [],
    relations: [],
    logs: []
  }
};

const labels = {
  teacher: "教师",
  parent: "家长",
  admin: "管理员",
  normal: "正常出勤",
  leave: "请假",
  pending: "待完成",
  completed: "已完成",
  create_class: "创建班级",
  join_class_by_code: "通过班级编号加入班级",
  update_user_status: "更新用户状态",
  reset_user_password: "重置用户密码",
  refresh_class_code: "刷新班级编号",
  disable_class_code: "停用班级编号",
  remove_student: "移除学生",
  bind_student_by_class_code: "通过班级编号绑定学生",
  update_student_status: "更新学生状态",
  create_parent_student_relation: "绑定家长学生关系",
  unbind_parent_student: "解绑家长学生关系",
  create_attendance: "创建出勤",
  update_attendance: "更新出勤",
  create_task: "创建任务",
  update_task: "更新任务",
  update_task_teacher_remark: "更新教师批注",
  delete_task: "删除任务",
  complete_task: "标记任务完成",
  mark_task_pending: "标记任务待完成"
};

function html(strings, ...values) {
  return strings.map((part, index) => part + (values[index] ?? "")).join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\n", " ");
}

function getTaskStatus(task) {
  if (task.status === "completed" || task.status === "pending") return task.status;
  return task.completed ? "completed" : "pending";
}

function canManageTask(task) {
  return ["parent", "teacher"].includes(state.user.role)
    && task.createdBy === state.user.id
    && getTaskStatus(task) === "pending";
}

function taskCreatorText(task) {
  const creator = task.createdByUser;
  if (!creator) return "未知用户";
  const source = creator.role === "teacher" ? "老师补充" : creator.role === "parent" ? "家长布置" : label(creator.role);
  return `${source} · ${creator.name}`;
}

function label(value) {
  return labels[value] || value;
}

function formatTaskTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function studentListName(student) {
  return student.name || student.displayName || "未命名学生";
}

function studentListMeta(student) {
  if (state.user.role === "teacher") return student.remark || "暂无备注";
  return student.class?.className || "未关联班级";
}

async function copyText(value) {
  const text = String(value || "");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function toast(message) {
  let node = document.querySelector(".toast");
  if (!node) {
    node = document.createElement("div");
    node.className = "toast";
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.add("show");
  window.clearTimeout(node.timer);
  node.timer = window.setTimeout(() => node.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setToken(token) {
  state.token = token || "";
  if (token) localStorage.setItem("stm_token", token);
  else localStorage.removeItem("stm_token");
}

function workspaceSelectionKey() {
  return state.user?.id ? `stm_workspace_selection:${state.user.id}` : "";
}

function restoreWorkspaceSelection() {
  state.selectedClassId = "";
  state.selectedStudentId = "";
  const key = workspaceSelectionKey();
  if (!key) return;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (!saved || typeof saved !== "object") return;
    if (state.user.role === "teacher" && typeof saved.classId === "string") {
      state.selectedClassId = saved.classId;
    }
    if (["teacher", "parent"].includes(state.user.role) && typeof saved.studentId === "string") {
      state.selectedStudentId = saved.studentId;
    }
  } catch {}
}

function rememberWorkspaceSelection() {
  const key = workspaceSelectionKey();
  if (!key || !["teacher", "parent"].includes(state.user.role)) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      classId: state.user.role === "teacher" ? state.selectedClassId : "",
      studentId: state.selectedStudentId
    }));
  } catch {}
}

async function boot() {
  if (!state.token) return renderAuth();
  try {
    const me = await api("/api/auth/me");
    state.user = me.user;
    state.parentOnboardingDismissed = false;
    state.classes = me.classes || [];
    state.students = me.students || [];
    restoreWorkspaceSelection();
    await loadWorkspaceData();
    renderApp();
  } catch {
    setToken("");
    renderAuth();
  }
}

function renderAuth(mode = "login") {
  app.innerHTML = html`
    <main class="auth-shell">
      <section class="auth-visual">
        <h1>学生托管系统</h1>
        <p>教师按班级管理出勤和任务完成，家长用班级编号绑定孩子并维护每日事项。</p>
      </section>
      <section class="auth-panel">
        <div class="auth-box">
          <div class="brand">
            <strong>${mode === "login" ? "登录" : "注册账号"}</strong>
            <span>第一版采用账号密码，后续可平滑接入微信登录。</span>
          </div>
          <div class="tabs">
            <button class="${mode === "login" ? "active" : ""}" data-auth-tab="login">登录</button>
            <button class="${mode === "register" ? "active" : ""}" data-auth-tab="register">注册</button>
          </div>
          <form id="authForm" class="form-grid">
            <div class="field">
              <label>账号 / 手机号</label>
              <input name="account" autocomplete="username" required />
            </div>
            <div class="field">
              <label>密码</label>
              <input name="password" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" required />
            </div>
            <div class="field ${mode === "login" ? "hidden" : ""}">
              <label>姓名</label>
              <input name="name" />
            </div>
            <div class="field ${mode === "login" ? "hidden" : ""}">
              <label>身份</label>
              <select name="role">
                <option value="parent">家长</option>
                <option value="teacher">教师</option>
              </select>
            </div>
            <button class="primary" type="submit">${mode === "login" ? "登录" : "创建账号"}</button>
          </form>
        </div>
      </section>
    </main>
  `;

  document.querySelectorAll("[data-auth-tab]").forEach((button) => {
    button.addEventListener("click", () => renderAuth(button.dataset.authTab));
  });

  document.querySelector("#authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formData(event.currentTarget);
    try {
      if (mode === "register") {
        await api("/api/auth/register", { method: "POST", body: data });
        toast("注册成功，请登录");
        renderAuth("login");
        return;
      }
      const result = await api("/api/auth/login", { method: "POST", body: data });
      setToken(result.token);
      state.user = result.user;
      await boot();
    } catch (error) {
      toast(error.message);
    }
  });
}

async function loadWorkspaceData() {
  if (!state.user) return;
  if (state.user.role === "admin") {
    const [users, classes, students, relations, logs] = await Promise.all([
      api("/api/users"),
      api("/api/classes"),
      api("/api/students"),
      api("/api/parent-student-relations"),
      api("/api/operation-logs")
    ]);
    state.adminData = {
      users: users.users || [],
      classes: classes.classes || [],
      students: students.students || [],
      relations: relations.relations || [],
      logs: logs.logs || []
    };
  } else if (state.user.role === "teacher") {
    const classes = await api("/api/classes");
    state.classes = classes.classes || [];
    if (!state.selectedClassId || !state.classes.some((item) => item.id === state.selectedClassId)) {
      state.selectedClassId = state.classes[0]?.id || "";
    }
    if (state.selectedClassId) {
      const result = await api(`/api/classes/${state.selectedClassId}/students`);
      state.students = result.students || [];
      if (!state.selectedStudentId || !state.students.some((item) => item.id === state.selectedStudentId)) {
        state.selectedStudentId = state.students[0]?.id || "";
      }
    } else {
      state.students = [];
      state.selectedStudentId = "";
    }
  } else if (state.user.role === "parent") {
    const result = await api("/api/students");
    state.students = result.students || [];
    if (!state.selectedStudentId || !state.students.some((item) => item.id === state.selectedStudentId)) {
      state.selectedStudentId = state.students[0]?.id || "";
    }
  }

  rememberWorkspaceSelection();

  if (state.selectedStudentId) {
    const [attendance, tasks, logs] = await Promise.all([
      api(`/api/attendance?studentId=${state.selectedStudentId}&date=${state.date}`),
      api(`/api/tasks?studentId=${state.selectedStudentId}&date=${state.date}`),
      api(`/api/operation-logs?studentId=${state.selectedStudentId}`)
    ]);
    state.attendance = attendance.attendance;
    state.tasks = tasks.tasks || [];
    state.logs = logs.logs || [];
  } else {
    state.attendance = null;
    state.tasks = [];
    state.logs = [];
  }
}

function renderApp() {
  if (state.user.role === "admin") return renderAdminApp();
  if (state.user.role === "teacher" && !state.classes.length) return renderTeacherOnboarding();
  if (state.user.role === "parent" && !state.students.length && !state.parentOnboardingDismissed) return renderParentOnboarding();

  app.innerHTML = html`
    <main class="app-shell">
      ${renderSidebar()}
      <section class="main">
        <div class="toolbar">
          <div>
            <h2 style="margin:0;">${state.user.role === "teacher" ? "班级工作台" : "家长工作台"}</h2>
            <div class="muted">${escapeHtml(state.user.name)} · ${labels[state.user.role]}</div>
          </div>
          <div class="actions">
            <div class="date-picker-control">
              <input id="dateInput" type="date" value="${state.date}" aria-label="工作日期" />
              <button class="date-picker-button" type="button" data-action="open-date-picker" aria-label="打开日历">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
                </svg>
              </button>
            </div>
            <button data-action="reload">刷新</button>
            <button data-action="logout">退出</button>
          </div>
        </div>
        <div class="workspace">
          <div>
            ${state.user.role === "parent" ? renderChildPanel() : ""}
            ${renderAttendancePanel()}
            ${renderTaskPanel()}
          </div>
          <aside class="workspace-aside">
            ${renderLogPanel()}
          </aside>
        </div>
      </section>
    </main>
  `;
  bindAppEvents();
}

function renderAdminApp() {
  const tabs = [
    ["users", "用户"],
    ["classes", "班级"],
    ["students", "学生"],
    ["relations", "绑定关系"],
    ["logs", "操作日志"]
  ];
  app.innerHTML = html`
    <main class="app-shell">
      <aside class="sidebar admin-sidebar">
        <h1>管理后台</h1>
        <div class="meta">${escapeHtml(state.user.name)} · 管理员</div>
        <nav class="admin-nav">
          ${tabs.map(([key, label]) => `<button class="${state.adminTab === key ? "active" : ""}" data-admin-tab="${key}">${label}</button>`).join("")}
        </nav>
      </aside>
      <section class="main">
        <div class="toolbar admin-toolbar">
          <div>
            <h2 style="margin:0;">${tabs.find(([key]) => key === state.adminTab)?.[1] || "管理后台"}</h2>
            <div class="muted">查看全局数据并处理异常绑定或账号状态。</div>
          </div>
          <div class="actions">
            <button data-action="reload">刷新</button>
            <button data-action="logout">退出</button>
          </div>
        </div>
        ${renderAdminPanel()}
      </section>
    </main>
  `;
  bindAdminEvents();
}

function renderAdminPanel() {
  if (state.adminTab === "users") return renderAdminUsers();
  if (state.adminTab === "classes") return renderAdminClasses();
  if (state.adminTab === "students") return renderAdminStudents();
  if (state.adminTab === "relations") return renderAdminRelations();
  return renderAdminLogs();
}

function renderAdminUsers() {
  const users = state.adminUserRoleFilter === "all"
    ? state.adminData.users
    : state.adminData.users.filter((user) => user.role === state.adminUserRoleFilter);
  return html`
    <section class="panel admin-users-panel">
      <div class="toolbar admin-users-toolbar" style="margin-bottom:14px;">
        <div class="field" style="max-width:220px;">
          <label>身份筛选</label>
          <select id="adminUserRoleFilter">
            <option value="all" ${state.adminUserRoleFilter === "all" ? "selected" : ""}>全部</option>
            <option value="teacher" ${state.adminUserRoleFilter === "teacher" ? "selected" : ""}>教师</option>
            <option value="parent" ${state.adminUserRoleFilter === "parent" ? "selected" : ""}>家长</option>
            <option value="admin" ${state.adminUserRoleFilter === "admin" ? "selected" : ""}>管理员</option>
          </select>
        </div>
        <div class="muted">共 ${users.length} 个账号</div>
      </div>
      <div class="admin-user-list">
        ${users.map((user) => html`
          <article class="admin-user-item">
            <div class="admin-user-heading">
              <div>
                <strong>${escapeHtml(user.name)}</strong>
                <span>${escapeHtml(user.account)}</span>
              </div>
              <span class="badge ${user.status === "active" ? "done" : "warn"}">${user.status === "active" ? "启用" : "停用"}</span>
            </div>
            <div class="admin-user-meta">
              <span>${labels[user.role] || user.role}</span>
              <span>${new Date(user.createdAt).toLocaleString()}</span>
            </div>
            <div class="admin-user-actions">
              <button class="primary" data-reset-password="${user.id}" data-user-name="${escapeAttr(user.name)}" data-user-account="${escapeAttr(user.account)}">修改密码</button>
              ${user.id === state.user.id ? `<span class="muted">当前账号</span>` : `<button data-user-status="${user.id}" data-status="${user.status === "active" ? "disabled" : "active"}">${user.status === "active" ? "停用账号" : "启用账号"}</button>`}
            </div>
          </article>
        `).join("")}
      </div>
      <div class="table-wrap admin-users-table">
        <table class="table">
          <thead>
            <tr><th>姓名</th><th>账号</th><th>身份</th><th>状态</th><th>创建时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${users.map((user) => html`
              <tr>
                <td>${escapeHtml(user.name)}</td>
                <td>${escapeHtml(user.account)}</td>
                <td>${labels[user.role] || user.role}</td>
                <td><span class="badge ${user.status === "active" ? "done" : "warn"}">${user.status === "active" ? "启用" : "停用"}</span></td>
                <td>${new Date(user.createdAt).toLocaleString()}</td>
                <td>
                  <div class="actions">
                    <button data-reset-password="${user.id}" data-user-name="${escapeAttr(user.name)}" data-user-account="${escapeAttr(user.account)}">修改密码</button>
                    ${user.id === state.user.id ? `<span class="muted">当前账号</span>` : `<button data-user-status="${user.id}" data-status="${user.status === "active" ? "disabled" : "active"}">${user.status === "active" ? "停用" : "启用"}</button>`}
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderAdminClasses() {
  return html`
    <section class="panel">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>班级</th><th>编号</th><th>加入状态</th><th>教师</th><th>创建时间</th></tr>
          </thead>
          <tbody>
            ${state.adminData.classes.map((classItem) => html`
              <tr>
                <td>${escapeHtml(classItem.className)}</td>
                <td><strong>${escapeHtml(classItem.classCode)}</strong></td>
                <td><span class="badge ${classItem.classCodeEnabled ? "done" : "warn"}">${classItem.classCodeEnabled ? "可加入" : "已停用"}</span></td>
                <td>${escapeHtml((classItem.teachers || []).map((item) => `${item.teacher?.name || "教师"}(${item.role === "owner" ? "创建者" : "协同"})`).join("、") || "未绑定")}</td>
                <td>${new Date(classItem.createdAt).toLocaleString()}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderAdminStudents() {
  const students = state.adminData.students.filter((student) => {
    if (state.adminStudentFilter === "active") return student.status === "active";
    if (state.adminStudentFilter === "removed") return student.status === "removed";
    if (state.adminStudentFilter === "unbound") return !student.parents?.length;
    return true;
  });
  return html`
    <section class="panel">
      <div class="toolbar" style="margin-bottom:14px;">
        <div class="field" style="max-width:220px;">
          <label>学生筛选</label>
          <select id="adminStudentFilter">
            <option value="all" ${state.adminStudentFilter === "all" ? "selected" : ""}>全部</option>
            <option value="active" ${state.adminStudentFilter === "active" ? "selected" : ""}>启用</option>
            <option value="removed" ${state.adminStudentFilter === "removed" ? "selected" : ""}>已移除</option>
            <option value="unbound" ${state.adminStudentFilter === "unbound" ? "selected" : ""}>未绑定家长</option>
          </select>
        </div>
        <div class="muted">共 ${students.length} 个学生</div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>学生</th><th>班级</th><th>家长</th><th>状态</th><th>创建时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${students.map((student) => html`
              <tr>
                <td>
                  ${escapeHtml(student.displayName || student.name)}
                  ${student.isDuplicate ? `<span class="badge warn">需核对</span>` : ""}
                </td>
                <td>${escapeHtml(student.class?.className || "未关联")}</td>
                <td>${escapeHtml((student.parents || []).map((item) => item.parent?.name || "家长").join("、") || "未绑定")}</td>
                <td><span class="badge ${student.status === "active" ? "done" : "warn"}">${student.status === "active" ? "启用" : "已移除"}</span></td>
                <td>${new Date(student.createdAt).toLocaleString()}</td>
                <td>
                  <div class="actions">
                    <button
                      data-bind-parent="${student.id}"
                      data-student-name="${escapeAttr(student.displayName || student.name)}"
                    >绑定家长</button>
                    <button
                      class="${student.status === "active" ? "danger" : ""}"
                      data-student-status="${student.id}"
                      data-status="${student.status === "active" ? "removed" : "active"}"
                      data-student-name="${escapeAttr(student.displayName || student.name)}"
                    >${student.status === "active" ? "移除" : "恢复"}</button>
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderAdminRelations() {
  return html`
    <section class="panel">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>家长</th><th>学生</th><th>班级</th><th>关系</th><th>绑定时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${state.adminData.relations.map((relation) => html`
              <tr>
                <td>${escapeHtml(relation.parent?.name || "未知家长")}<br><span class="muted">${escapeHtml(relation.parent?.account || "")}</span></td>
                <td>${escapeHtml(relation.student?.displayName || relation.student?.name || "未知学生")}</td>
                <td>${escapeHtml(relation.class?.className || "未关联")}</td>
                <td>${escapeHtml(relation.relationType || "监护人")}</td>
                <td>${new Date(relation.createdAt).toLocaleString()}</td>
                <td>
                  <button
                    class="danger"
                    data-delete-relation="${relation.id}"
                    data-parent-name="${escapeAttr(relation.parent?.name || "未知家长")}"
                    data-student-name="${escapeAttr(relation.student?.displayName || relation.student?.name || "未知学生")}"
                    data-class-name="${escapeAttr(relation.class?.className || "未关联")}"
                  >解绑</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderAdminLogs() {
  return html`
    <section class="panel">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>时间</th><th>操作人</th><th>身份</th><th>操作</th><th>对象</th><th>日期</th></tr>
          </thead>
          <tbody>
            ${state.adminData.logs.map((log) => html`
              <tr>
                <td>${new Date(log.createdAt).toLocaleString()}</td>
                <td>${escapeHtml(log.operatorName)}</td>
                <td>${escapeHtml(label(log.operatorRole))}</td>
                <td><span class="badge">${escapeHtml(label(log.action))}</span></td>
                <td>${escapeHtml(log.objectType)}<br><span class="muted">${escapeHtml(log.objectId)}</span></td>
                <td>${escapeHtml(log.date || "")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderSidebar() {
  const selectedStudent = state.students.find((item) => item.id === state.selectedStudentId) || state.students[0] || null;
  const selectedClass = state.classes.find((item) => item.id === state.selectedClassId) || state.classes[0] || null;
  const classPicker = state.user.role === "teacher"
    ? html`
      <div class="field">
        <label>当前班级</label>
        <select id="classSelect">
          ${state.classes.map((item) => `<option value="${item.id}" ${item.id === state.selectedClassId ? "selected" : ""}>${escapeHtml(item.className)}</option>`).join("")}
        </select>
        ${selectedClass ? html`
          <div class="class-quickbar">
            <div class="class-code-summary">
              <span>班级编号</span>
              <strong>${escapeHtml(selectedClass.classCode)}</strong>
            </div>
            <div class="class-quick-actions">
              <button type="button" data-action="copy-class-code" data-class-code="${escapeAttr(selectedClass.classCode)}">复制</button>
              <button type="button" data-action="show-class-settings">设置</button>
            </div>
          </div>
        ` : ""}
      </div>
    `
    : "";

  return html`
    <aside class="sidebar">
      <h1>学生托管系统</h1>
      <div class="meta">${labels[state.user.role]} · ${escapeHtml(state.user.account)}</div>
      ${classPicker}
      <div class="field sidebar-students">
        <label>${state.user.role === "teacher" ? "选择学生" : "选择孩子"}</label>
        ${state.students.length ? html`
          <div class="student-combobox" id="studentPicker">
            <button class="student-picker-trigger" id="studentPickerTrigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="studentPickerDropdown">
              <span class="student-picker-copy">
                <strong>${escapeHtml(studentListName(selectedStudent))}</strong>
                <span>${escapeHtml(studentListMeta(selectedStudent))}</span>
              </span>
              <span class="student-picker-chevron" aria-hidden="true">⌄</span>
            </button>
            <div class="student-picker-dropdown hidden" id="studentPickerDropdown">
              <input id="studentSearchInput" type="search" placeholder="搜索姓名、编号或备注" autocomplete="off" aria-label="搜索学生" />
              <div class="student-picker-options" role="listbox" aria-label="学生列表">
                ${state.students.map((student) => html`
                  <button class="student-picker-option ${student.id === state.selectedStudentId ? "active" : ""}" data-student-id="${student.id}" data-student-search="${escapeAttr(`${studentListName(student)} ${student.studentNo || ""} ${student.remark || ""} ${studentListMeta(student)}`.toLowerCase())}" type="button" role="option" aria-selected="${student.id === state.selectedStudentId ? "true" : "false"}">
                    <span class="student-name">${escapeHtml(studentListName(student))}</span>
                    <span class="student-meta">${escapeHtml(studentListMeta(student))}</span>
                  </button>
                `).join("")}
                <div class="notice student-picker-empty hidden">没有匹配的学生</div>
              </div>
            </div>
          </div>
        ` : `<div class="notice">暂无学生</div>`}
      </div>
      ${state.user.role === "teacher" ? "" : html`
        <div class="actions" style="margin-top:16px;">
          <button class="primary" data-action="show-bind-child">绑定孩子</button>
        </div>
      `}
    </aside>
  `;
}

function renderAttendancePanel() {
  const attendance = state.attendance || {
    morningStatus: "normal",
    afternoonStatus: "normal",
    morningRemark: "",
    afternoonRemark: ""
  };
  return html`
    <section class="panel">
      <h2>出勤</h2>
      ${state.selectedStudentId ? html`
        <form id="attendanceForm" class="form-grid">
          <div class="two-col">
            <div class="field">
              <label>上午</label>
              <select name="morningStatus">
                <option value="normal" ${attendance.morningStatus === "normal" ? "selected" : ""}>正常出勤</option>
                <option value="leave" ${attendance.morningStatus === "leave" ? "selected" : ""}>请假</option>
              </select>
            </div>
            <div class="field">
              <label>下午</label>
              <select name="afternoonStatus">
                <option value="normal" ${attendance.afternoonStatus === "normal" ? "selected" : ""}>正常出勤</option>
                <option value="leave" ${attendance.afternoonStatus === "leave" ? "selected" : ""}>请假</option>
              </select>
            </div>
          </div>
          <div class="two-col">
            <div class="field">
              <label>上午备注</label>
              <input name="morningRemark" value="${escapeHtml(attendance.morningRemark || "")}" />
            </div>
            <div class="field">
              <label>下午备注</label>
              <input name="afternoonRemark" value="${escapeHtml(attendance.afternoonRemark || "")}" />
            </div>
          </div>
          <button class="primary" type="submit">保存出勤</button>
        </form>
      ` : `<div class="notice">请选择学生</div>`}
    </section>
  `;
}

function renderTaskPanel() {
  const canCreate = Boolean(state.selectedStudentId) && ["parent", "teacher"].includes(state.user.role);
  const canComplete = state.user.role === "teacher";
  const canRemark = state.user.role === "teacher";
  return html`
    <section class="panel">
      <h2>每日任务</h2>
      ${canCreate ? html`
        <form id="taskForm" class="three-col">
          <div class="field">
            <label>任务标题</label>
            <input name="title" required />
          </div>
          <div class="field">
            <label>任务内容</label>
            <input name="content" />
          </div>
          <button class="primary" type="submit">添加</button>
        </form>
      ` : ""}
      <div class="list task-list" style="margin-top:14px;">
        ${state.tasks.length ? state.tasks.map((task) => html`
          <div class="item task-card">
            <div class="item-title">
              <span>${escapeHtml(task.title)}</span>
              <span class="badge ${getTaskStatus(task) === "completed" ? "done" : "todo"}">${labels[getTaskStatus(task)]}</span>
            </div>
            <p>${escapeHtml(task.content || "无任务说明")}</p>
            <dl class="task-audit">
              <div>
                <dt>创建人</dt>
                <dd>${escapeHtml(taskCreatorText(task))}<time>${escapeHtml(formatTaskTimestamp(task.createdAt))}</time></dd>
              </div>
              <div>
                <dt>最后修改</dt>
                <dd>${escapeHtml(task.lastModifiedByUser?.name || task.createdByUser?.name || "未知用户")}<time>${escapeHtml(formatTaskTimestamp(task.updatedAt))}</time></dd>
              </div>
              ${getTaskStatus(task) === "completed" ? html`
                <div>
                  <dt>完成确认</dt>
                  <dd>${escapeHtml(task.completedByUser?.name || "托管老师")}<time>${escapeHtml(formatTaskTimestamp(task.completedAt))}</time></dd>
                </div>
              ` : ""}
            </dl>
            ${canRemark ? html`
              <div class="task-remark-editor">
                <div class="task-remark-header">
                  <label>教师批注</label>
                  <span data-task-remark-status="${task.id}">自动保存</span>
                </div>
                <textarea data-task-remark="${task.id}" data-last-saved="${escapeAttr(task.teacherRemark || "")}" placeholder="填写给家长查看的批注">${escapeHtml(task.teacherRemark || "")}</textarea>
              </div>
            ` : task.teacherRemark ? html`
              <div class="task-remark-view">
                <strong>教师批注</strong>
                <p>${escapeHtml(task.teacherRemark)}</p>
              </div>
            ` : ""}
            <div class="actions task-actions" style="margin-top:10px;">
              ${canComplete ? html`
                <label class="check-row">
                  <input data-task-completed="${task.id}" type="checkbox" ${getTaskStatus(task) === "completed" ? "checked" : ""} />
                  <span>标记完成</span>
                </label>
              ` : ""}
              ${canManageTask(task) ? html`
                <div class="task-owner-actions">
                  <button type="button" data-edit-task="${task.id}">编辑</button>
                  <button type="button" data-delete-task="${task.id}" data-task-title="${escapeAttr(task.title)}" class="danger">删除</button>
                </div>
              ` : ""}
            </div>
          </div>
        `).join("") : `<div class="notice">当天暂无任务</div>`}
      </div>
    </section>
  `;
}

function renderEditTaskDialog(task) {
  const dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  dialog.innerHTML = html`
    <div class="modal">
      <div class="item-title">
        <h3 style="margin:0;">编辑任务</h3>
        <button class="text" type="button" data-modal-close>关闭</button>
      </div>
      <form id="editTaskForm" class="form-grid" style="margin-top:14px;">
        <div class="field">
          <label>任务标题</label>
          <input name="title" value="${escapeAttr(task.title)}" required />
        </div>
        <div class="field">
          <label>任务内容</label>
          <textarea name="content">${escapeHtml(task.content || "")}</textarea>
        </div>
        <button class="primary" type="submit">保存修改</button>
      </form>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.querySelector("[data-modal-close]").addEventListener("click", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.remove();
  });
  dialog.querySelector("#editTaskForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = event.currentTarget.querySelector("button[type='submit']");
    submitButton.disabled = true;
    try {
      await api(`/api/tasks/${task.id}`, { method: "PUT", body: formData(event.currentTarget) });
      toast("任务已更新");
      dialog.remove();
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      submitButton.disabled = false;
      toast(error.message);
    }
  });
  const titleInput = dialog.querySelector("input[name='title']");
  titleInput?.focus();
  titleInput?.select();
}

function renderClassPanel() {
  const classItem = state.classes.find((item) => item.id === state.selectedClassId);
  if (!classItem) return `<div class="notice">暂无班级</div>`;
  const isOwner = classItem.teacherRole === "owner" || state.user.role === "admin";
  return html`
    <div class="class-settings-content">
      <div class="item">
        <div class="item-title">
          <span>${escapeHtml(classItem.className)}</span>
          <span class="badge ${classItem.teacherRole === "owner" ? "" : "warn"}">${classItem.teacherRole === "owner" ? "创建者" : "协同教师"}</span>
        </div>
        <p>加入状态：<span class="badge ${classItem.classCodeEnabled ? "" : "warn"}">${classItem.classCodeEnabled ? "可加入" : "已停用"}</span></p>
        <p>班级编号：<strong>${escapeHtml(classItem.classCode)}</strong></p>
        <div class="actions" style="margin-top:10px;">
          <button data-action="refresh-class-code" ${isOwner ? "" : "disabled"}>刷新编号</button>
          <button data-action="copy-class-code" data-class-code="${escapeAttr(classItem.classCode)}">复制编号</button>
          <button class="danger" data-action="disable-class-code" ${isOwner ? "" : "disabled"}>停用编号</button>
        </div>
        ${isOwner ? "" : `<p class="muted">只有班级创建者可以刷新或停用班级编号。</p>`}
      </div>
      <div class="muted" style="margin-top:12px;">家长和协同教师都可以使用班级编号加入，权限由登录身份决定。</div>
      ${classItem.teachers?.length ? html`
        <h3 style="margin-top:18px;">教师</h3>
        <div class="list">
          ${classItem.teachers.map((item) => html`
            <div class="item">
              <div class="item-title">
                <span>${escapeHtml(item.teacher?.name || "教师")}</span>
                <span class="badge ${item.role === "owner" ? "" : "warn"}">${item.role === "owner" ? "创建者" : "协同教师"}</span>
              </div>
              <p>${escapeHtml(item.teacher?.account || "")}</p>
            </div>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function renderCreateClassDialog() {
  const dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  dialog.innerHTML = html`
    <div class="modal">
      <div class="item-title">
        <h3 style="margin:0;">新建班级</h3>
        <button class="text" type="button" data-modal-close>关闭</button>
      </div>
      <form id="createClassDialogForm" class="form-grid" style="margin-top:14px;">
        <div class="field">
          <label>班级名称</label>
          <input name="className" placeholder="例如：一年级一班" required />
        </div>
        <div class="field">
          <label>年级</label>
          <input name="grade" placeholder="选填" />
        </div>
        <button class="primary" type="submit">创建班级</button>
      </form>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.querySelector("[data-modal-close]").addEventListener("click", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.remove();
  });
  dialog.querySelector("#createClassDialogForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/api/classes", { method: "POST", body: formData(event.currentTarget) });
      state.selectedClassId = result.class.id;
      state.selectedStudentId = "";
      toast("班级已创建");
      dialog.remove();
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      toast(error.message);
    }
  });
  dialog.querySelector("input")?.focus();
}

function renderClassSettingsDialog() {
  const dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  dialog.innerHTML = html`
    <div class="modal class-settings-modal">
      <div class="item-title">
        <h3 style="margin:0;">班级设置</h3>
        <button class="text" type="button" data-modal-close>关闭</button>
      </div>
      <div class="class-settings-scroll">
        ${renderClassPanel()}
      </div>
      <div class="class-entry-actions">
        <button type="button" data-action="show-create-class">新建班级</button>
        <button type="button" data-action="show-join-class">加入班级</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.querySelector("[data-modal-close]").addEventListener("click", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.remove();
  });
  dialog.querySelector("[data-action='refresh-class-code']")?.addEventListener("click", async () => {
    try {
      await api(`/api/classes/${state.selectedClassId}/code/refresh`, { method: "POST" });
      toast("班级编号已刷新");
      dialog.remove();
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      toast(error.message);
    }
  });
  dialog.querySelector("[data-action='disable-class-code']")?.addEventListener("click", async () => {
    const confirmed = window.confirm("确定要停用当前班级编号吗？停用后家长和协同教师将无法继续使用该编号加入。");
    if (!confirmed) return;
    try {
      await api(`/api/classes/${state.selectedClassId}/code/disable`, { method: "POST" });
      toast("班级编号已停用");
      dialog.remove();
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      toast(error.message);
    }
  });
  dialog.querySelector("[data-action='copy-class-code']")?.addEventListener("click", async (event) => {
    try {
      await copyText(event.currentTarget.dataset.classCode);
      toast("班级编号已复制");
    } catch {
      toast("复制失败，请手动复制编号");
    }
  });
  dialog.querySelector("[data-action='show-create-class']").addEventListener("click", () => {
    dialog.remove();
    renderCreateClassDialog();
  });
  dialog.querySelector("[data-action='show-join-class']").addEventListener("click", () => {
    dialog.remove();
    renderJoinClassDialog();
  });
}

function renderChildPanel() {
  const student = state.students.find((item) => item.id === state.selectedStudentId);
  return html`
    <section class="panel">
      <h2>孩子信息</h2>
      ${student ? html`
        <div class="item">
          <div class="item-title">
            <span>${escapeHtml(student.name)}</span>
            <span class="badge">${escapeHtml(student.class?.className || "班级")}</span>
          </div>
          <p>编号：${escapeHtml(student.studentNo || "未填写")}</p>
        </div>
      ` : `<div class="notice">暂无绑定孩子</div>`}
    </section>
  `;
}

function renderLogPanel() {
  return html`
    <section class="panel log-panel">
      <h2>操作日志</h2>
      <div class="list log-list">
        ${state.logs.length ? state.logs.map((log) => html`
          <div class="item">
            <div class="item-title">
              <span>${escapeHtml(log.operatorName || log.operatorRole)}</span>
              <span class="badge">${escapeHtml(label(log.action))}</span>
            </div>
            <p>${new Date(log.createdAt).toLocaleString()} · ${escapeHtml(log.date || "")}</p>
          </div>
        `).join("") : `<div class="notice">暂无日志</div>`}
      </div>
    </section>
  `;
}

function renderTeacherOnboarding() {
  app.innerHTML = html`
    <main class="auth-shell">
      <section class="auth-visual">
        <h1>创建或加入班级</h1>
        <p>创建班级的教师是班级创建者，其他教师可通过班级编号加入协同管理。</p>
      </section>
      <section class="auth-panel">
        <div class="auth-box form-grid">
          <div class="brand">
            <strong>班级入口</strong>
            <span>${escapeHtml(state.user.name)} · 教师</span>
          </div>
          <form id="createClassForm" class="form-grid">
            <div class="field">
              <label>创建班级</label>
              <input name="className" placeholder="例如：一年级一班" required />
            </div>
            <button class="primary" type="submit">创建班级</button>
          </form>
          <form id="joinClassForm" class="form-grid" style="margin-top:18px;">
            <div class="field">
              <label>加入已有班级</label>
              <input name="classCode" placeholder="输入班级编号" required />
            </div>
            <button type="submit">加入班级</button>
          </form>
          <button type="button" data-action="logout">退出</button>
        </div>
      </section>
    </main>
  `;
  bindGlobalActions();
  document.querySelector("#createClassForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/classes", { method: "POST", body: formData(event.currentTarget) });
      toast("班级已创建");
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      toast(error.message);
    }
  });
  document.querySelector("#joinClassForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/classes/join-by-code", { method: "POST", body: formData(event.currentTarget) });
      toast("已加入班级");
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      toast(error.message);
    }
  });
}

function renderJoinClassDialog() {
  const dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  dialog.innerHTML = html`
    <div class="modal">
      <div class="item-title">
        <h3 style="margin:0;">加入班级</h3>
        <button class="text" type="button" data-modal-close>关闭</button>
      </div>
      <form id="joinClassDialogForm" class="form-grid" style="margin-top:14px;">
        <div class="field">
          <label>班级编号</label>
          <input name="classCode" placeholder="输入老师提供的班级编号" required />
        </div>
        <button class="primary" type="submit">加入</button>
      </form>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.querySelector("[data-modal-close]").addEventListener("click", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.remove();
  });
  dialog.querySelector("#joinClassDialogForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/classes/join-by-code", { method: "POST", body: formData(event.currentTarget) });
      toast("已加入班级");
      dialog.remove();
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      toast(error.message);
    }
  });
  dialog.querySelector("input")?.focus();
}

function renderBindParentDialog(studentId, studentName) {
  const dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  dialog.innerHTML = html`
    <div class="modal">
      <div class="item-title">
        <h3 style="margin:0;">绑定家长</h3>
        <button class="text" type="button" data-modal-close>关闭</button>
      </div>
      <div class="muted" style="margin-top:8px;">学生：${escapeHtml(studentName)}</div>
      <form id="bindParentForm" class="form-grid" style="margin-top:14px;">
        <div class="field">
          <label>家长账号</label>
          <input name="parentAccount" placeholder="输入已注册家长账号" required />
        </div>
        <div class="field">
          <label>关系</label>
          <input name="relationType" value="监护人" />
        </div>
        <button class="primary" type="submit">建立绑定</button>
      </form>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.querySelector("[data-modal-close]").addEventListener("click", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.remove();
  });
  dialog.querySelector("#bindParentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/parent-student-relations", {
        method: "POST",
        body: {
          ...formData(event.currentTarget),
          studentId
        }
      });
      toast("绑定关系已建立");
      dialog.remove();
      await loadWorkspaceData();
      renderAdminApp();
    } catch (error) {
      toast(error.message);
    }
  });
  dialog.querySelector("input")?.focus();
}

function renderResetPasswordDialog(userId, userName, userAccount) {
  const isCurrentUser = userId === state.user.id;
  const dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  dialog.innerHTML = html`
    <div class="modal">
      <div class="item-title">
        <h3 style="margin:0;">修改用户密码</h3>
        <button class="text" type="button" data-modal-close>关闭</button>
      </div>
      <div class="muted" style="margin-top:8px;">${escapeHtml(userName)} · ${escapeHtml(userAccount)}</div>
      <form id="resetPasswordForm" class="form-grid" style="margin-top:14px;">
        <div class="field">
          <label>新密码</label>
          <input name="newPassword" type="password" minlength="6" maxlength="128" autocomplete="new-password" required />
        </div>
        <div class="field">
          <label>确认新密码</label>
          <input name="confirmPassword" type="password" minlength="6" maxlength="128" autocomplete="new-password" required />
        </div>
        <div class="notice">修改后，该用户已登录的设备将全部退出。${isCurrentUser ? "当前管理账号也会退出，请使用新密码重新登录。" : ""}</div>
        <button class="primary" type="submit">确认修改</button>
      </form>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.querySelector("[data-modal-close]").addEventListener("click", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.remove();
  });
  dialog.querySelector("#resetPasswordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formData(event.currentTarget);
    if (data.newPassword !== data.confirmPassword) {
      toast("两次输入的密码不一致");
      return;
    }
    const submitButton = event.currentTarget.querySelector("button[type='submit']");
    submitButton.disabled = true;
    try {
      await api(`/api/users/${userId}/password`, {
        method: "PATCH",
        body: { newPassword: data.newPassword }
      });
      dialog.remove();
      if (isCurrentUser) {
        setToken("");
        state.user = null;
        renderAuth();
        toast("密码已修改，请使用新密码重新登录");
        return;
      }
      toast("密码已修改，该用户的登录已退出");
      await loadWorkspaceData();
      renderAdminApp();
    } catch (error) {
      submitButton.disabled = false;
      toast(error.message);
    }
  });
  dialog.querySelector("input")?.focus();
}

function renderParentOnboarding() {
  app.innerHTML = html`
    <main class="auth-shell">
      <section class="auth-visual">
        <h1>绑定孩子</h1>
        <p>向老师获取班级编号，填写孩子姓名后即可进入每日出勤和任务管理。</p>
      </section>
      <section class="auth-panel">
        <form id="bindChildForm" class="auth-box form-grid">
          <div class="brand">
            <strong>加入班级</strong>
            <span>${escapeHtml(state.user.name)} · 家长</span>
          </div>
          <div class="field">
            <label>班级编号</label>
            <input name="classCode" placeholder="例如：A8K392" required />
          </div>
          <div class="field">
            <label>孩子姓名</label>
            <input name="studentName" required />
          </div>
          <div class="field">
            <label>学生编号或备注</label>
            <input name="studentNo" placeholder="可选，用于区分同名学生" />
          </div>
          <button class="primary" type="submit">绑定孩子</button>
          <button type="button" data-action="cancel-bind-child">${state.students.length ? "返回工作台" : "暂不添加"}</button>
          <button class="text" type="button" data-action="logout">退出登录</button>
        </form>
      </section>
    </main>
  `;
  bindGlobalActions();
  document.querySelector("[data-action='cancel-bind-child']").addEventListener("click", () => {
    state.parentOnboardingDismissed = true;
    renderApp();
  });
  document.querySelector("#bindChildForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/api/students/bind-by-class-code", { method: "POST", body: formData(event.currentTarget) });
      if (result.alreadyBound) {
        toast("该孩子已经绑定过");
      } else {
        toast("孩子已绑定");
      }
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      toast(error.message);
    }
  });
}

function bindGlobalActions() {
  document.querySelectorAll("[data-action='logout']").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api("/api/auth/logout", { method: "POST" });
      } catch {}
      setToken("");
      state.user = null;
      renderAuth();
    });
  });
}

function bindAdminEvents() {
  bindGlobalActions();

  document.querySelector("[data-action='reload']")?.addEventListener("click", async () => {
    try {
      await loadWorkspaceData();
      renderAdminApp();
      toast("刷新成功");
    } catch (error) {
      toast(error.message);
    }
  });

  document.querySelectorAll("[data-admin-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.adminTab = button.dataset.adminTab;
      renderAdminApp();
    });
  });

  document.querySelector("#adminUserRoleFilter")?.addEventListener("change", (event) => {
    state.adminUserRoleFilter = event.currentTarget.value;
    renderAdminApp();
  });

  document.querySelector("#adminStudentFilter")?.addEventListener("change", (event) => {
    state.adminStudentFilter = event.currentTarget.value;
    renderAdminApp();
  });

  document.querySelectorAll("[data-user-status]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(`/api/users/${button.dataset.userStatus}/status`, {
          method: "PATCH",
          body: { status: button.dataset.status }
        });
        toast(button.dataset.status === "active" ? "用户已启用" : "用户已停用");
        await loadWorkspaceData();
        renderAdminApp();
      } catch (error) {
        toast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-reset-password]").forEach((button) => {
    button.addEventListener("click", () => {
      renderResetPasswordDialog(
        button.dataset.resetPassword,
        button.dataset.userName,
        button.dataset.userAccount
      );
    });
  });

  document.querySelectorAll("[data-student-status]").forEach((button) => {
    button.addEventListener("click", async () => {
      const removing = button.dataset.status === "removed";
      if (removing) {
        const message = `确认移除学生？\n\n学生：${button.dataset.studentName}\n\n移除后默认列表不再显示，但出勤、任务和日志会保留。`;
        if (!window.confirm(message)) return;
      }
      try {
        await api(`/api/students/${button.dataset.studentStatus}/status`, {
          method: "PATCH",
          body: { status: button.dataset.status }
        });
        toast(removing ? "学生已移除" : "学生已恢复");
        await loadWorkspaceData();
        renderAdminApp();
      } catch (error) {
        toast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-bind-parent]").forEach((button) => {
    button.addEventListener("click", () => {
      renderBindParentDialog(button.dataset.bindParent, button.dataset.studentName);
    });
  });

  document.querySelectorAll("[data-delete-relation]").forEach((button) => {
    button.addEventListener("click", async () => {
      const message = `确认解除绑定关系？\n\n家长：${button.dataset.parentName}\n学生：${button.dataset.studentName}\n班级：${button.dataset.className}`;
      if (!window.confirm(message)) return;
      try {
        await api(`/api/parent-student-relations/${button.dataset.deleteRelation}`, { method: "DELETE" });
        toast("绑定关系已解除");
        await loadWorkspaceData();
        renderAdminApp();
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

function bindAppEvents() {
  bindGlobalActions();

  const studentPicker = document.querySelector("#studentPicker");
  const studentPickerTrigger = document.querySelector("#studentPickerTrigger");
  const studentPickerDropdown = document.querySelector("#studentPickerDropdown");
  const studentSearchInput = document.querySelector("#studentSearchInput");
  const datePickerControl = document.querySelector(".date-picker-control");
  const dateInput = document.querySelector("#dateInput");
  const closeStudentPicker = () => {
    studentPickerDropdown?.classList.add("hidden");
    studentPicker?.classList.remove("open");
    studentPickerTrigger?.setAttribute("aria-expanded", "false");
  };

  studentPickerTrigger?.addEventListener("click", () => {
    const opening = studentPickerDropdown.classList.contains("hidden");
    studentPickerDropdown.classList.toggle("hidden", !opening);
    studentPicker.classList.toggle("open", opening);
    studentPickerTrigger.setAttribute("aria-expanded", String(opening));
    if (opening) {
      studentSearchInput.value = "";
      studentSearchInput.dispatchEvent(new Event("input"));
      studentSearchInput.focus();
    }
  });

  studentSearchInput?.addEventListener("input", () => {
    const query = studentSearchInput.value.trim().toLowerCase();
    let matches = 0;
    studentPicker.querySelectorAll("[data-student-search]").forEach((option) => {
      const matched = option.dataset.studentSearch.includes(query);
      option.hidden = !matched;
      if (matched) matches += 1;
    });
    studentPicker.querySelector(".student-picker-empty")?.classList.toggle("hidden", matches > 0);
  });

  studentPickerDropdown?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeStudentPicker();
    studentPickerTrigger.focus();
  });

  app.onpointerdown = (event) => {
    if (studentPicker && !studentPicker.contains(event.target)) closeStudentPicker();
    if (dateInput && datePickerControl && !datePickerControl.contains(event.target)) dateInput.blur();
  };

  document.querySelector("[data-action='reload']")?.addEventListener("click", async () => {
    try {
      await loadWorkspaceData();
      renderApp();
      toast("刷新成功");
    } catch (error) {
      toast(error.message);
    }
  });

  dateInput?.addEventListener("change", async (event) => {
    state.date = event.currentTarget.value;
    await loadWorkspaceData();
    renderApp();
  });

  document.querySelector("[data-action='open-date-picker']")?.addEventListener("click", () => {
    dateInput.focus({ preventScroll: true });
    try {
      if (typeof dateInput.showPicker === "function") dateInput.showPicker();
      else dateInput.click();
    } catch {
      dateInput.click();
    }
  });

  document.querySelector("#classSelect")?.addEventListener("change", async (event) => {
    state.selectedClassId = event.currentTarget.value;
    state.selectedStudentId = "";
    await loadWorkspaceData();
    renderApp();
  });

  document.querySelectorAll("[data-student-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      closeStudentPicker();
      state.selectedStudentId = button.dataset.studentId;
      await loadWorkspaceData();
      renderApp();
    });
  });

  document.querySelector("#attendanceForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/attendance", {
        method: "PUT",
        body: {
          ...formData(event.currentTarget),
          studentId: state.selectedStudentId,
          date: state.date
        }
      });
      toast("出勤已保存");
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      toast(error.message);
    }
  });

  document.querySelector("#taskForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/tasks", {
        method: "POST",
        body: {
          ...formData(event.currentTarget),
          studentId: state.selectedStudentId,
          date: state.date
        }
      });
      toast("任务已添加");
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      toast(error.message);
    }
  });

  document.querySelectorAll("[data-task-completed]").forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      try {
        await api(`/api/tasks/${checkbox.dataset.taskCompleted}/completion`, {
          method: "PATCH",
          body: { status: checkbox.checked ? "completed" : "pending" }
        });
        await loadWorkspaceData();
        renderApp();
      } catch (error) {
        toast(error.message);
      }
    });
  });

  const saveTaskRemark = async (textarea) => {
    const taskId = textarea.dataset.taskRemark;
    const value = textarea.value;
    const status = document.querySelector(`[data-task-remark-status="${taskId}"]`);
    if (value === textarea.dataset.lastSaved) {
      if (status) status.textContent = "已保存";
      return;
    }
    if (status) status.textContent = "保存中...";
    try {
      await api(`/api/tasks/${taskId}/teacher-remark`, {
        method: "PATCH",
        body: { teacherRemark: value }
      });
      textarea.dataset.lastSaved = value;
      const task = state.tasks.find((item) => item.id === taskId);
      if (task) task.teacherRemark = value;
      if (status) status.textContent = "已保存";
    } catch (error) {
      if (status) status.textContent = "保存失败";
      toast(error.message);
    }
  };

  document.querySelectorAll("[data-task-remark]").forEach((textarea) => {
    textarea.addEventListener("input", () => {
      const status = document.querySelector(`[data-task-remark-status="${textarea.dataset.taskRemark}"]`);
      if (status) status.textContent = "编辑中...";
      window.clearTimeout(textarea.saveTimer);
      textarea.saveTimer = window.setTimeout(() => saveTaskRemark(textarea), 800);
    });
    textarea.addEventListener("blur", async () => {
      window.clearTimeout(textarea.saveTimer);
      try {
        await saveTaskRemark(textarea);
      } catch (error) {
        toast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-delete-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm(`确定删除任务“${button.dataset.taskTitle}”吗？`)) return;
      try {
        await api(`/api/tasks/${button.dataset.deleteTask}`, { method: "DELETE" });
        toast("任务已删除");
        await loadWorkspaceData();
        renderApp();
      } catch (error) {
        toast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-edit-task]").forEach((button) => {
    button.addEventListener("click", () => {
      const task = state.tasks.find((item) => item.id === button.dataset.editTask);
      if (task && canManageTask(task)) renderEditTaskDialog(task);
    });
  });

  document.querySelector("[data-action='copy-class-code']")?.addEventListener("click", async (event) => {
    try {
      await copyText(event.currentTarget.dataset.classCode);
      toast("班级编号已复制");
    } catch {
      toast("复制失败，请手动复制编号");
    }
  });

  document.querySelector("[data-action='show-class-settings']")?.addEventListener("click", () => renderClassSettingsDialog());
  document.querySelector("[data-action='show-bind-child']")?.addEventListener("click", () => renderParentOnboarding());
}

boot();
