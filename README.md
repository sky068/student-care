# 学生托管系统

简单 Web 版学生托管系统，后端使用原生 Node.js，数据默认写入 SQLite 数据库 `data/stumng.sqlite`。

普通账号可以同时开通教师、家长身份并切换工作台；班级关系、孩子绑定、最近选择和任务操作权限均按当前身份隔离，适配移动端。

## 启动

```bash
npm run dev
```

默认访问地址：

```text
http://127.0.0.1:3000
```

## 生产部署

推荐使用 Docker Compose 一键部署：

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh deploy
```

默认仅监听服务器本机；正式公网部署请先将域名解析到服务器，并使用 `DOMAIN=care.example.com ./scripts/deploy.sh deploy` 自动启用 HTTPS。没有域名且需要临时通过公网 IP 访问时，可使用 `APP_BIND=0.0.0.0 ALLOW_INSECURE_HTTP=true ./scripts/deploy.sh deploy`，但明文 HTTP 不适合长期使用。

完整的服务器准备、HTTPS、配置、备份、恢复和升级说明见 [部署说明](doc/部署说明.md)。

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



* 家长端截图:

![image-20260715153409453](/Users/skyxu/Library/Application Support/typora-user-images/image-20260715153409453.png)

* 教师端截图:

![image-20260715154547615](/Users/skyxu/Library/Application Support/typora-user-images/image-20260715154547615.png)

* 管理员端截图:

![image-20260715154748136](/Users/skyxu/Library/Application Support/typora-user-images/image-20260715154748136.png)
