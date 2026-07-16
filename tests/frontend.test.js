import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("孩子备注编辑不会被全局焦点逻辑阻断", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /data-child-remark-editor/);
  assert.match(source, /setTimeout\(saveChildRemark, 1000\)/);
  assert.match(source, /querySelectorAll\("\.student-picker-option\[data-student-id\]"\)/, "学生切换监听只能绑定下拉选项");
  assert.doesNotMatch(source, /querySelectorAll\("\[data-student-id\]"\)/, "宽泛选择器会把出勤表单误当成学生选项并重绘页面");
});

test("新建和编辑任务弹窗都显示学生和任务日期", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /renderTaskDialogContext\(selectedStudent, state\.date\)/, "新建弹窗应显示当前工作台日期");
  assert.match(source, /renderTaskDialogContext\(selectedStudent, task\.date\)/, "编辑弹窗应显示任务自身日期");
});
