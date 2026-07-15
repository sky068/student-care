const app = document.querySelector("#app");

function formatBusinessDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

const archiveStart = new Date();
archiveStart.setDate(archiveStart.getDate() - 180);
let workspaceLoadGeneration = 0;
let authGeneration = 0;
const taskRemarkSaveQueues = new Map();

const state = {
  token: localStorage.getItem("stm_token") || "",
  user: null,
  classes: [],
  students: [],
  selectedClassId: "",
  selectedStudentId: "",
  parentOnboardingDismissed: false,
  roleOnboardingSuppressed: false,
  date: formatBusinessDate(),
  tasks: [],
  attendance: null,
  logs: [],
  adminTab: "users",
  adminUserRoleFilter: "all",
  adminStudentFilter: "all",
  adminLogView: "recent",
  adminArchiveStartDate: formatBusinessDate(archiveStart),
  adminArchiveEndDate: formatBusinessDate(),
  adminArchiveLogs: [],
  adminRecentLogTotal: 0,
  adminRecentLogsHaveMore: false,
  adminArchiveLogTotal: 0,
  adminArchiveLogsHaveMore: false,
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
  refresh_teacher_invite_code: "刷新教师邀请码",
  disable_teacher_invite_code: "停用教师邀请码",
  add_user_role: "开通账号身份",
  switch_user_role: "切换账号身份",
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
  mark_task_pending: "标记任务待完成",
  task: "任务",
  attendance: "出勤",
  student: "学生",
  class: "班级",
  user: "用户",
  relation: "绑定关系"
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

function configureTaskDialog(dialog, { titleInput, selectTitle = false, trigger = null } = {}) {
  const closeButton = dialog.querySelector("[data-modal-close]");
  const panel = dialog.querySelector("[role='dialog']");
  const appWasInert = app.hasAttribute("inert");
  let closed = false;

  if (!appWasInert) app.setAttribute("inert", "");

  const closeDialog = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", handleKeydown);
    dialog.remove();
    if (!appWasInert) app.removeAttribute("inert");
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
  const handleKeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab" || !panel) return;
    const focusable = [...panel.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener("keydown", handleKeydown);
  closeButton?.addEventListener("click", closeDialog);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });

  if (window.matchMedia("(max-width: 640px), (any-pointer: coarse)").matches) {
    closeButton?.focus({ preventScroll: true });
  } else {
    titleInput?.focus({ preventScroll: true });
    if (selectTitle) titleInput?.select();
  }
  return closeDialog;
}

function getTaskStatus(task) {
  if (task.status === "completed" || task.status === "pending") return task.status;
  return task.completed ? "completed" : "pending";
}

function canManageTask(task) {
  return ["parent", "teacher"].includes(state.user.role)
    && task.createdBy === state.user.id
    && task.createdByRole === state.user.role
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

function userRoleText(user) {
  const roles = Array.isArray(user.roles) && user.roles.length ? user.roles : [user.role];
  return roles.map(label).join(" / ");
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
  return student.displayName || student.name || "未命名学生";
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
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.add("show");
  window.clearTimeout(node.timer);
  node.timer = window.setTimeout(() => node.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const { skipActiveRole = false, ...requestOptions } = options;
  const headers = { "content-type": "application/json", ...(requestOptions.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (!skipActiveRole && state.user?.role) headers["x-active-role"] = state.user.role;
  const response = await fetch(path, {
    ...requestOptions,
    headers,
    body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setToken(token) {
  const nextToken = token || "";
  if (state.token !== nextToken) authGeneration += 1;
  state.token = nextToken;
  if (token) localStorage.setItem("stm_token", token);
  else localStorage.removeItem("stm_token");
}

function workspaceSelectionKey() {
  return state.user?.id && state.user?.role ? `stm_workspace_selection:${state.user.id}:${state.user.role}` : "";
}

function resetWorkspaceState() {
  workspaceLoadGeneration += 1;
  state.classes = [];
  state.students = [];
  state.selectedClassId = "";
  state.selectedStudentId = "";
  state.tasks = [];
  state.attendance = null;
  state.logs = [];
  state.parentOnboardingDismissed = false;
  state.roleOnboardingSuppressed = false;
}

async function switchRole(role) {
  if (!role || role === state.user?.role) return;
  const expectedToken = state.token;
  const expectedGeneration = authGeneration;
  let result;
  try {
    result = await api("/api/auth/switch-role", { method: "POST", body: { role } });
  } catch (error) {
    if (state.token !== expectedToken || authGeneration !== expectedGeneration) throw error;
    try {
      const current = await api("/api/auth/me", { skipActiveRole: true });
      if (state.token !== expectedToken || authGeneration !== expectedGeneration) throw error;
      state.user = current.user;
      if (current.user.role !== role) {
        throw error;
      }
      result = current;
    } catch {
      throw error;
    }
  }
  if (state.token !== expectedToken || authGeneration !== expectedGeneration) return;
  resetWorkspaceState();
  state.roleOnboardingSuppressed = true;
  state.user = result.user;
  restoreWorkspaceSelection();
  let loadError = null;
  try {
    await loadWorkspaceData();
  } catch (error) {
    loadError = error;
  }
  renderApp();
  toast(`已切换为${label(role)}身份`);
  if (loadError) window.setTimeout(() => toast(`身份已切换，数据加载失败：${loadError.message}`), 300);
}

function renderRoleSwitcher() {
  if (!state.user || state.user.role === "admin") return "";
  const roles = Array.isArray(state.user.roles) && state.user.roles.length ? state.user.roles : [state.user.role];
  const otherRole = ["teacher", "parent"].find((role) => !roles.includes(role));
  return html`
    <div class="identity-switcher">
      <div class="field">
        <label>当前身份</label>
        <select data-role-switch aria-label="切换当前身份">
          ${roles.map((role) => `<option value="${role}" ${role === state.user.role ? "selected" : ""}>${label(role)}</option>`).join("")}
        </select>
      </div>
      ${otherRole ? `<button type="button" data-add-role="${otherRole}">开通${label(otherRole)}身份</button>` : ""}
    </div>
  `;
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
    state.roleOnboardingSuppressed = false;
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
              <input name="account" autocomplete="username" maxlength="64" required />
            </div>
            <div class="field">
              <label>密码</label>
              <input name="password" type="password" minlength="${mode === "login" ? "1" : "6"}" maxlength="128" autocomplete="${mode === "login" ? "current-password" : "new-password"}" required />
            </div>
            <div class="field ${mode === "login" ? "hidden" : ""}">
              <label>姓名</label>
              <input name="name" maxlength="50" />
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
  const generation = ++workspaceLoadGeneration;
  if (state.user.role === "admin") {
    const [users, classes, students, relations, logs] = await Promise.all([
      api("/api/users"),
      api("/api/classes"),
      api("/api/students"),
      api("/api/parent-student-relations"),
      api("/api/operation-logs?limit=50&offset=0")
    ]);
    if (generation !== workspaceLoadGeneration) return;
    state.adminData = {
      users: users.users || [],
      classes: classes.classes || [],
      students: students.students || [],
      relations: relations.relations || [],
      logs: logs.logs || []
    };
    state.adminRecentLogTotal = logs.total || state.adminData.logs.length;
    state.adminRecentLogsHaveMore = Boolean(logs.hasMore);
  } else if (state.user.role === "teacher") {
    const classes = await api("/api/classes");
    if (generation !== workspaceLoadGeneration) return;
    state.classes = classes.classes || [];
    if (!state.selectedClassId || !state.classes.some((item) => item.id === state.selectedClassId)) {
      state.selectedClassId = state.classes[0]?.id || "";
    }
    if (state.selectedClassId) {
      const result = await api(`/api/classes/${state.selectedClassId}/students`);
      if (generation !== workspaceLoadGeneration) return;
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
    if (generation !== workspaceLoadGeneration) return;
    state.students = result.students || [];
    if (!state.selectedStudentId || !state.students.some((item) => item.id === state.selectedStudentId)) {
      state.selectedStudentId = state.students[0]?.id || "";
    }
  }

  rememberWorkspaceSelection();

  if (state.selectedStudentId) {
    const studentId = state.selectedStudentId;
    const date = state.date;
    const [attendance, tasks, logs] = await Promise.all([
      api(`/api/attendance?studentId=${studentId}&date=${date}`),
      api(`/api/tasks?studentId=${studentId}&date=${date}`),
      api(`/api/operation-logs?studentId=${studentId}`)
    ]);
    if (generation !== workspaceLoadGeneration || studentId !== state.selectedStudentId || date !== state.date) return;
    state.attendance = attendance.attendance;
    state.tasks = tasks.tasks || [];
    state.logs = logs.logs || [];
  } else {
    state.attendance = null;
    state.tasks = [];
    state.logs = [];
  }
}

async function loadAdminArchivedLogs(append = false) {
  const params = new URLSearchParams({
    startDate: state.adminArchiveStartDate,
    endDate: state.adminArchiveEndDate,
    limit: "50",
    offset: append ? String(state.adminArchiveLogs.length) : "0"
  });
  const result = await api(`/api/operation-logs/archive?${params}`);
  state.adminArchiveLogs = append ? [...state.adminArchiveLogs, ...(result.logs || [])] : result.logs || [];
  state.adminArchiveLogTotal = result.total || state.adminArchiveLogs.length;
  state.adminArchiveLogsHaveMore = Boolean(result.hasMore);
}

async function loadMoreAdminRecentLogs() {
  const result = await api(`/api/operation-logs?limit=50&offset=${state.adminData.logs.length}`);
  state.adminData.logs = [...state.adminData.logs, ...(result.logs || [])];
  state.adminRecentLogTotal = result.total || state.adminData.logs.length;
  state.adminRecentLogsHaveMore = Boolean(result.hasMore);
}

function renderApp() {
  if (state.user.role === "admin") return renderAdminApp();
  if (state.user.role === "teacher" && !state.classes.length && !state.roleOnboardingSuppressed) return renderTeacherOnboarding();
  if (state.user.role === "parent" && !state.students.length && !state.parentOnboardingDismissed && !state.roleOnboardingSuppressed) return renderParentOnboarding();

  app.innerHTML = html`
    <main class="app-shell">
      ${renderSidebar()}
      <section class="main">
        <div class="toolbar workspace-toolbar">
          <div>
            <h2 style="margin:0;">${state.user.role === "teacher" ? "班级工作台" : "家长工作台"}</h2>
            <div class="muted">${escapeHtml(state.user.name)} · ${labels[state.user.role]}</div>
          </div>
          <div class="actions workspace-toolbar-actions">
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
            ${state.user.role === "teacher" && !state.classes.length
              ? renderTeacherEmptyWorkspace()
              : state.user.role === "parent" && !state.students.length
                ? renderParentEmptyWorkspace()
                : html`
                  ${state.user.role === "parent" ? renderChildPanel() : ""}
                  ${renderAttendancePanel()}
                  ${renderTaskPanel()}
                `}
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

function renderTeacherEmptyWorkspace() {
  return html`
    <section class="panel empty-workspace-panel">
      <h2>教师工作台</h2>
      <p class="muted">当前教师身份还没有管理班级。你可以稍后创建班级，或使用教师邀请码加入已有班级。</p>
      <div class="actions">
        <button class="primary" type="button" data-action="show-create-class">创建班级</button>
        <button type="button" data-action="show-join-class">加入班级</button>
      </div>
    </section>
  `;
}

function renderParentEmptyWorkspace() {
  return html`
    <section class="panel empty-workspace-panel">
      <h2>家长工作台</h2>
      <p class="muted">当前家长身份还没有绑定孩子。需要添加时，请使用上方的“绑定孩子”按钮。</p>
    </section>
  `;
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
    : state.adminData.users.filter((user) => (user.roles || [user.role]).includes(state.adminUserRoleFilter));
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
              <span>${escapeHtml(userRoleText(user))}</span>
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
                <td>${escapeHtml(userRoleText(user))}</td>
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
    <section class="panel admin-responsive-panel">
      <div class="admin-mobile-list">
        ${state.adminData.classes.map((classItem) => html`
          <article class="admin-mobile-record">
            <div class="admin-mobile-heading">
              <strong>${escapeHtml(classItem.className)}</strong>
              <span class="badge ${classItem.classCodeEnabled ? "done" : "warn"}">${classItem.classCodeEnabled ? "可加入" : "已停用"}</span>
            </div>
            <dl class="admin-mobile-meta">
              <div><dt>班级编号</dt><dd>${escapeHtml(classItem.classCode)}</dd></div>
              <div><dt>教师</dt><dd>${escapeHtml((classItem.teachers || []).map((item) => `${item.teacher?.name || "教师"}(${item.role === "owner" ? "创建者" : "协同"})`).join("、") || "未绑定")}</dd></div>
              <div><dt>创建时间</dt><dd>${new Date(classItem.createdAt).toLocaleString()}</dd></div>
            </dl>
          </article>
        `).join("") || `<div class="notice">暂无班级</div>`}
      </div>
      <div class="table-wrap admin-desktop-table">
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
    <section class="panel admin-responsive-panel">
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
      <div class="admin-mobile-list">
        ${students.map((student) => html`
          <article class="admin-mobile-record">
            <div class="admin-mobile-heading">
              <strong>${escapeHtml(student.displayName || student.name)}</strong>
              <span class="badge ${student.status === "active" ? "done" : "warn"}">${student.status === "active" ? "启用" : "已移除"}</span>
            </div>
            ${student.isDuplicate ? `<span class="badge warn admin-mobile-flag">需核对</span>` : ""}
            <dl class="admin-mobile-meta">
              <div><dt>班级</dt><dd>${escapeHtml(student.class?.className || "未关联")}</dd></div>
              <div><dt>家长</dt><dd>${escapeHtml((student.parents || []).map((item) => item.parent?.name || "家长").join("、") || "未绑定")}</dd></div>
              <div><dt>创建时间</dt><dd>${new Date(student.createdAt).toLocaleString()}</dd></div>
            </dl>
            <div class="admin-mobile-actions">
              <button data-bind-parent="${student.id}" data-student-name="${escapeAttr(student.displayName || student.name)}">绑定家长</button>
              <button
                class="${student.status === "active" ? "danger" : ""}"
                data-student-status="${student.id}"
                data-status="${student.status === "active" ? "removed" : "active"}"
                data-student-name="${escapeAttr(student.displayName || student.name)}"
              >${student.status === "active" ? "移除" : "恢复"}</button>
            </div>
          </article>
        `).join("") || `<div class="notice">暂无学生</div>`}
      </div>
      <div class="table-wrap admin-desktop-table">
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
    <section class="panel admin-responsive-panel">
      <div class="admin-mobile-list">
        ${state.adminData.relations.map((relation) => html`
          <article class="admin-mobile-record">
            <div class="admin-mobile-heading">
              <strong>${escapeHtml(relation.student?.displayName || relation.student?.name || "未知学生")}</strong>
              <span class="badge">${escapeHtml(relation.relationType || "监护人")}</span>
            </div>
            <dl class="admin-mobile-meta">
              <div><dt>家长</dt><dd>${escapeHtml(relation.parent?.name || "未知家长")} · ${escapeHtml(relation.parent?.account || "")}</dd></div>
              <div><dt>班级</dt><dd>${escapeHtml(relation.class?.className || "未关联")}</dd></div>
              <div><dt>绑定时间</dt><dd>${new Date(relation.createdAt).toLocaleString()}</dd></div>
            </dl>
            <div class="admin-mobile-actions one-action">
              <button
                class="danger"
                data-delete-relation="${relation.id}"
                data-parent-name="${escapeAttr(relation.parent?.name || "未知家长")}"
                data-student-name="${escapeAttr(relation.student?.displayName || relation.student?.name || "未知学生")}"
                data-class-name="${escapeAttr(relation.class?.className || "未关联")}"
              >解除绑定</button>
            </div>
          </article>
        `).join("") || `<div class="notice">暂无绑定关系</div>`}
      </div>
      <div class="table-wrap admin-desktop-table">
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

function renderAdminLogObject(log) {
  return html`
    <button class="text log-object-button" type="button" data-log-detail="${log.id}">
      ${escapeHtml(label(log.objectType))}：${escapeHtml(log.objectName || log.objectId)}
    </button>
    ${log.objectContext ? `<div class="muted">${escapeHtml(log.objectContext)}</div>` : ""}
    <div class="log-object-id">${escapeHtml(log.objectId)}</div>
  `;
}

function renderAdminLogs() {
  const showingArchive = state.adminLogView === "archive";
  const logs = showingArchive ? state.adminArchiveLogs : state.adminData.logs;
  const total = showingArchive ? state.adminArchiveLogTotal : state.adminRecentLogTotal;
  const hasMore = showingArchive ? state.adminArchiveLogsHaveMore : state.adminRecentLogsHaveMore;
  return html`
    <section class="panel admin-responsive-panel">
      <div class="toolbar" style="margin-bottom:14px;">
        <div class="actions">
          <button class="${showingArchive ? "" : "primary"}" type="button" data-admin-log-view="recent">最近 14 天</button>
          <button class="${showingArchive ? "primary" : ""}" type="button" data-admin-log-view="archive">历史归档</button>
        </div>
        <div class="muted">已加载 ${logs.length} / ${total} 条</div>
      </div>
      ${showingArchive ? html`
        <form id="archiveLogForm" class="three-col" style="margin-bottom:14px;">
          <div class="field">
            <label>开始日期</label>
            <input name="startDate" type="date" value="${escapeAttr(state.adminArchiveStartDate)}" required />
          </div>
          <div class="field">
            <label>结束日期</label>
            <input name="endDate" type="date" value="${escapeAttr(state.adminArchiveEndDate)}" required />
          </div>
          <button class="primary" type="submit">查询归档</button>
        </form>
      ` : ""}
      <div class="admin-mobile-list admin-log-list">
        ${logs.map((log) => html`
          <article class="admin-mobile-record">
            <div class="admin-mobile-heading">
              <strong>${escapeHtml(label(log.action))}</strong>
              <span class="badge">${escapeHtml(label(log.operatorRole))}</span>
            </div>
            <div class="admin-log-operator">${escapeHtml(log.operatorName || "未知用户")} · ${new Date(log.createdAt).toLocaleString()}</div>
            <div class="admin-log-object">${renderAdminLogObject(log)}</div>
            ${log.date ? `<div class="muted">业务日期：${escapeHtml(log.date)}</div>` : ""}
          </article>
        `).join("") || `<div class="notice">${showingArchive ? "所选日期内暂无归档日志" : "最近 14 天暂无操作日志"}</div>`}
      </div>
      <div class="table-wrap admin-desktop-table">
        <table class="table">
          <thead>
            <tr><th>时间</th><th>操作人</th><th>身份</th><th>操作</th><th>对象</th><th>日期</th></tr>
          </thead>
          <tbody>
            ${logs.map((log) => html`
              <tr>
                <td>${new Date(log.createdAt).toLocaleString()}</td>
                <td>${escapeHtml(log.operatorName)}</td>
                <td>${escapeHtml(label(log.operatorRole))}</td>
                <td><span class="badge">${escapeHtml(label(log.action))}</span></td>
                <td>${renderAdminLogObject(log)}</td>
                <td>${escapeHtml(log.date || "")}</td>
              </tr>
            `).join("") || `<tr><td colspan="6" class="muted">${showingArchive ? "所选日期内暂无归档日志" : "最近 14 天暂无操作日志"}</td></tr>`}
          </tbody>
        </table>
      </div>
      ${hasMore ? `<button class="admin-load-more" type="button" data-load-more-logs>加载更多（剩余 ${Math.max(total - logs.length, 0)} 条）</button>` : ""}
    </section>
  `;
}

function renderOperationLogDialog(log) {
  const dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  const beforeData = log.beforeData ? JSON.stringify(log.beforeData, null, 2) : "无";
  const afterData = log.afterData ? JSON.stringify(log.afterData, null, 2) : "无";
  dialog.innerHTML = html`
    <div class="modal log-detail-modal">
      <div class="item-title">
        <h3 style="margin:0;">操作日志详情</h3>
        <button class="text" type="button" data-modal-close>关闭</button>
      </div>
      <div class="log-detail-grid">
        <div><span>操作</span><strong>${escapeHtml(label(log.action))}</strong></div>
        <div><span>操作人</span><strong>${escapeHtml(log.operatorName || "未知用户")}</strong></div>
        <div><span>对象</span><strong>${escapeHtml(log.objectName || log.objectId)}</strong></div>
        <div><span>时间</span><strong>${escapeHtml(new Date(log.createdAt).toLocaleString())}</strong></div>
      </div>
      ${log.objectContext ? `<div class="notice log-detail-context">${escapeHtml(log.objectContext)}</div>` : ""}
      <div class="log-snapshot-grid">
        <section>
          <h4>修改前</h4>
          <pre>${escapeHtml(beforeData)}</pre>
        </section>
        <section>
          <h4>修改后</h4>
          <pre>${escapeHtml(afterData)}</pre>
        </section>
      </div>
      <div class="log-object-id">对象 ID：${escapeHtml(log.objectId)}</div>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.querySelector("[data-modal-close]").addEventListener("click", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.remove();
  });
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
      ${renderRoleSwitcher()}
      ${classPicker}
      <div class="field sidebar-students">
        <label>${state.user.role === "teacher" ? "选择学生" : "选择孩子"}</label>
        <div class="student-picker-row ${state.students.length ? "" : "empty"}">
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
          ${state.user.role === "parent" ? `<button class="primary bind-child-quick" type="button" data-action="show-bind-child">绑定孩子</button>` : ""}
        </div>
      </div>
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
          <div class="attendance-row">
            <div class="field">
              <label>上午出勤</label>
              <select name="morningStatus">
                <option value="normal" ${attendance.morningStatus === "normal" ? "selected" : ""}>正常出勤</option>
                <option value="leave" ${attendance.morningStatus === "leave" ? "selected" : ""}>请假</option>
              </select>
            </div>
            <div class="field">
              <label>上午备注</label>
              <input name="morningRemark" maxlength="500" placeholder="选填" value="${escapeHtml(attendance.morningRemark || "")}" />
            </div>
          </div>
          <div class="attendance-row">
            <div class="field">
              <label>下午出勤</label>
              <select name="afternoonStatus">
                <option value="normal" ${attendance.afternoonStatus === "normal" ? "selected" : ""}>正常出勤</option>
                <option value="leave" ${attendance.afternoonStatus === "leave" ? "selected" : ""}>请假</option>
              </select>
            </div>
            <div class="field">
              <label>下午备注</label>
              <input name="afternoonRemark" maxlength="500" placeholder="选填" value="${escapeHtml(attendance.afternoonRemark || "")}" />
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
      <div class="task-panel-header">
        <h2>每日任务</h2>
        ${canCreate ? `<button class="primary" type="button" data-action="show-create-task">新建任务</button>` : ""}
      </div>
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

function renderCreateTaskDialog(trigger = null) {
  const selectedStudent = state.students.find((item) => item.id === state.selectedStudentId);
  if (!selectedStudent) return;
  const dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  dialog.innerHTML = html`
    <div class="modal task-form-modal" role="dialog" aria-modal="true" aria-labelledby="createTaskDialogTitle">
      <div class="item-title">
        <h3 id="createTaskDialogTitle" style="margin:0;">新建任务</h3>
        <button class="text" type="button" data-modal-close>关闭</button>
      </div>
      <div class="notice task-dialog-context">
        <strong>${escapeHtml(studentListName(selectedStudent))}</strong>
        <span>${escapeHtml(state.date)}</span>
      </div>
      <form id="createTaskForm" class="form-grid" style="margin-top:14px;">
        <div class="field">
          <label for="createTaskTitle">任务标题</label>
          <input id="createTaskTitle" name="title" required />
        </div>
        <div class="field">
          <label for="createTaskContent">任务内容</label>
          <textarea id="createTaskContent" name="content" placeholder="选填"></textarea>
        </div>
        <button class="primary" type="submit">创建任务</button>
      </form>
    </div>
  `;
  document.body.appendChild(dialog);
  const closeDialog = configureTaskDialog(dialog, {
    titleInput: dialog.querySelector("input[name='title']"),
    trigger
  });
  dialog.querySelector("#createTaskForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = event.currentTarget.querySelector("button[type='submit']");
    submitButton.disabled = true;
    submitButton.textContent = "创建中...";
    try {
      await api("/api/tasks", {
        method: "POST",
        body: {
          ...formData(event.currentTarget),
          studentId: state.selectedStudentId,
          date: state.date
        }
      });
      closeDialog();
      toast("任务已添加");
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      submitButton.disabled = false;
      submitButton.textContent = "创建任务";
      toast(error.message);
    }
  });
}

function renderEditTaskDialog(task, trigger = null) {
  const dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  dialog.innerHTML = html`
    <div class="modal task-form-modal" role="dialog" aria-modal="true" aria-labelledby="editTaskDialogTitle">
      <div class="item-title">
        <h3 id="editTaskDialogTitle" style="margin:0;">编辑任务</h3>
        <button class="text" type="button" data-modal-close>关闭</button>
      </div>
      <form id="editTaskForm" class="form-grid" style="margin-top:14px;">
        <div class="field">
          <label for="editTaskTitle">任务标题</label>
          <input id="editTaskTitle" name="title" value="${escapeAttr(task.title)}" required />
        </div>
        <div class="field">
          <label for="editTaskContent">任务内容</label>
          <textarea id="editTaskContent" name="content">${escapeHtml(task.content || "")}</textarea>
        </div>
        <button class="primary" type="submit">保存修改</button>
      </form>
    </div>
  `;
  document.body.appendChild(dialog);
  const titleInput = dialog.querySelector("input[name='title']");
  const closeDialog = configureTaskDialog(dialog, {
    titleInput,
    selectTitle: true,
    trigger
  });
  dialog.querySelector("#editTaskForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = event.currentTarget.querySelector("button[type='submit']");
    submitButton.disabled = true;
    try {
      await api(`/api/tasks/${task.id}`, { method: "PUT", body: formData(event.currentTarget) });
      toast("任务已更新");
      closeDialog();
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      submitButton.disabled = false;
      toast(error.message);
    }
  });
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
        <p>家长绑定码：<strong>${escapeHtml(classItem.classCode)}</strong></p>
        <p>教师邀请码：<strong>${escapeHtml(classItem.teacherInviteCode || "未生成")}</strong> <span class="badge ${classItem.teacherInviteCodeEnabled !== false ? "" : "warn"}">${classItem.teacherInviteCodeEnabled !== false ? "可加入" : "已停用"}</span></p>
        <div class="actions" style="margin-top:10px;">
          <button data-action="refresh-class-code" ${isOwner ? "" : "disabled"}>刷新编号</button>
          <button data-action="copy-class-code" data-class-code="${escapeAttr(classItem.classCode)}">复制编号</button>
          <button data-action="copy-class-code" data-class-code="${escapeAttr(classItem.teacherInviteCode || "")}">复制教师邀请码</button>
          <button data-action="refresh-teacher-code" ${isOwner ? "" : "disabled"}>刷新教师邀请码</button>
          <button class="danger" data-action="disable-teacher-code" ${isOwner ? "" : "disabled"}>停用教师邀请码</button>
          <button class="danger" data-action="disable-class-code" ${isOwner ? "" : "disabled"}>停用编号</button>
        </div>
        ${isOwner ? "" : `<p class="muted">只有班级创建者可以刷新或停用班级编号。</p>`}
      </div>
      <div class="muted" style="margin-top:12px;">家长绑定码仅供家长添加孩子；协同教师必须使用单独的教师邀请码。</div>
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
    const confirmed = window.confirm("确定要停用当前家长绑定码吗？停用后家长将无法继续使用该编号添加孩子。");
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
  dialog.querySelector("[data-action='refresh-teacher-code']")?.addEventListener("click", async () => {
    try {
      await api(`/api/classes/${state.selectedClassId}/teacher-code/refresh`, { method: "POST" });
      toast("教师邀请码已刷新");
      dialog.remove();
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      toast(error.message);
    }
  });
  dialog.querySelector("[data-action='disable-teacher-code']")?.addEventListener("click", async () => {
    if (!window.confirm("确定停用教师邀请码吗？停用后新的协同教师将无法加入。")) return;
    try {
      await api(`/api/classes/${state.selectedClassId}/teacher-code/disable`, { method: "POST" });
      toast("教师邀请码已停用");
      dialog.remove();
      await loadWorkspaceData();
      renderApp();
    } catch (error) {
      toast(error.message);
    }
  });
  dialog.querySelectorAll("[data-action='copy-class-code']").forEach((button) => {
    button.addEventListener("click", async (event) => {
      try {
        await copyText(event.currentTarget.dataset.classCode);
        toast("邀请码已复制");
      } catch {
        toast("复制失败，请手动复制");
      }
    });
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
          <p>备注：${escapeHtml(student.remark || "未填写")}</p>
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
        <p>创建班级的教师是班级创建者，其他教师可通过教师邀请码加入协同管理。</p>
      </section>
      <section class="auth-panel">
        <div class="auth-box form-grid">
          <div class="brand">
            <strong>班级入口</strong>
            <span>${escapeHtml(state.user.name)} · 教师</span>
          </div>
          ${renderRoleSwitcher()}
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
              <input name="classCode" placeholder="输入教师邀请码" required />
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
          <label>教师邀请码</label>
          <input name="classCode" placeholder="输入班级创建者提供的教师邀请码" required />
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
          ${renderRoleSwitcher()}
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
  document.querySelectorAll("[data-role-switch]").forEach((select) => {
    select.addEventListener("change", async () => {
      const previousRole = state.user.role;
      const expectedGeneration = authGeneration;
      select.disabled = true;
      try {
        await switchRole(select.value);
      } catch (error) {
        if (select.isConnected && authGeneration === expectedGeneration) {
          select.value = previousRole;
          select.disabled = false;
          toast(error.message);
        }
      }
    });
  });

  document.querySelectorAll("[data-add-role]").forEach((button) => {
    button.addEventListener("click", async () => {
      const role = button.dataset.addRole;
      if (!window.confirm(`确定开通${label(role)}身份吗？两个身份的数据入口和操作权限相互独立。`)) return;
      button.disabled = true;
      const expectedToken = state.token;
      const expectedGeneration = authGeneration;
      try {
        const result = await api("/api/auth/roles", { method: "POST", body: { role } });
        if (state.token !== expectedToken || authGeneration !== expectedGeneration) return;
        state.user = result.user;
        await switchRole(role);
      } catch (error) {
        if (state.token === expectedToken && authGeneration === expectedGeneration) {
          try {
            const current = await api("/api/auth/me", { skipActiveRole: true });
            if (state.token === expectedToken && authGeneration === expectedGeneration) {
              state.user = current.user;
              renderApp();
            }
          } catch {}
        }
        if (button.isConnected) button.disabled = false;
        if (state.token === expectedToken && authGeneration === expectedGeneration) toast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-action='logout']").forEach((button) => {
    button.addEventListener("click", async () => {
      authGeneration += 1;
      try {
        await api("/api/auth/logout", { method: "POST" });
      } catch {}
      setToken("");
      resetWorkspaceState();
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

  document.querySelectorAll("[data-admin-log-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        if (button.dataset.adminLogView === "archive") await loadAdminArchivedLogs();
        state.adminLogView = button.dataset.adminLogView;
        renderAdminApp();
      } catch (error) {
        toast(error.message);
      }
    });
  });

  document.querySelector("#archiveLogForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formData(event.currentTarget);
    state.adminArchiveStartDate = data.startDate;
    state.adminArchiveEndDate = data.endDate;
    try {
      await loadAdminArchivedLogs();
      renderAdminApp();
    } catch (error) {
      toast(error.message);
    }
  });

  document.querySelectorAll("[data-log-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      const logs = state.adminLogView === "archive" ? state.adminArchiveLogs : state.adminData.logs;
      const log = logs.find((item) => item.id === button.dataset.logDetail);
      if (log) renderOperationLogDialog(log);
    });
  });

  document.querySelector("[data-load-more-logs]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "加载中...";
    try {
      if (state.adminLogView === "archive") await loadAdminArchivedLogs(true);
      else await loadMoreAdminRecentLogs();
      renderAdminApp();
    } catch (error) {
      button.disabled = false;
      button.textContent = "加载更多";
      toast(error.message);
    }
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

  document.querySelectorAll("[data-task-completed]").forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      const previousChecked = !checkbox.checked;
      checkbox.disabled = true;
      try {
        await api(`/api/tasks/${checkbox.dataset.taskCompleted}/completion`, {
          method: "PATCH",
          body: { status: checkbox.checked ? "completed" : "pending" }
        });
        await loadWorkspaceData();
        renderApp();
      } catch (error) {
        checkbox.checked = previousChecked;
        checkbox.disabled = false;
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
    const previous = taskRemarkSaveQueues.get(taskId) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      await api(`/api/tasks/${taskId}/teacher-remark`, {
        method: "PATCH",
        body: { teacherRemark: value }
      });
      textarea.dataset.lastSaved = value;
      const task = state.tasks.find((item) => item.id === taskId);
      if (task) task.teacherRemark = value;
      if (status && textarea.value === value) status.textContent = "已保存";
    });
    taskRemarkSaveQueues.set(taskId, current);
    try {
      await current;
    } catch (error) {
      if (status && textarea.value === value) status.textContent = "保存失败";
      toast(error.message);
    } finally {
      if (taskRemarkSaveQueues.get(taskId) === current) taskRemarkSaveQueues.delete(taskId);
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
      if (task && canManageTask(task)) renderEditTaskDialog(task, button);
    });
  });

  document.querySelector("[data-action='show-create-task']")?.addEventListener("click", (event) => {
    renderCreateTaskDialog(event.currentTarget);
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
  document.querySelectorAll("[data-action='show-create-class']").forEach((button) => button.addEventListener("click", renderCreateClassDialog));
  document.querySelectorAll("[data-action='show-join-class']").forEach((button) => button.addEventListener("click", renderJoinClassDialog));
  document.querySelectorAll("[data-action='show-bind-child']").forEach((button) => button.addEventListener("click", () => renderParentOnboarding()));
}

boot();
