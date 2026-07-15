# 学生托管系统

简单 Web 版学生托管系统，后端使用原生 Node.js，数据默认写入 SQLite 数据库 `data/stumng.sqlite`。

## 启动

```bash
npm run dev
```

默认访问地址：

```text
http://127.0.0.1:3000
```

## 管理员配置

管理员不通过注册页面创建。部署时通过环境变量初始化：

```bash
ADMIN_ACCOUNT=admin ADMIN_PASSWORD=change-me ADMIN_NAME=系统管理员 npm run dev
```

如果管理员账号不存在，服务启动时会自动创建；如果账号已存在，会更新为管理员角色并刷新密码。

可参考 `.env.example` 配置部署环境变量。

## 数据存储

系统使用 SQLite 单文件数据库：

```text
data/stumng.sqlite
```

SQLite 不是加密数据库。部署时应限制服务器文件权限，并做好数据库文件备份；如果后续有强隐私或合规要求，再考虑 SQLCipher 或云数据库托管。

## 测试数据

手动创建一套测试数据：

```bash
npm run seed:test
```

脚本会创建或更新：

- 教师账号：`teacher_test / test123456`
- 家长账号：`parent_test / test123456`
- 班级：`测试一班`，班级编号 `TEST01`
- 两个学生：`测试学生一`、`测试学生二`
- 每个学生 2 条默认 `待完成` 任务

脚本是幂等的，重复执行不会无限新增同一批测试数据。
