# dsh-sysmon — 系统性能看板（小悬浮窗）

![version](https://img.shields.io/badge/version-0.1.0-4f8ef7) ![license](https://img.shields.io/badge/license-BSD--3--Clause-9b59b6) ![platform](https://img.shields.io/badge/platform-DSH%20Web-00c2a8)

> DSH Web GUI 右下角的小悬浮窗，实时展示本机 CPU / 内存 / 磁盘 / 网络 / 负载 / 运行时长。占用极小：host 采集无第三方 npm 依赖（`/proc` + `node:os`；唯一的子进程是后台 `ss -tinp` 采样，用于进程级网络 TOP10）、client 零框架（原生 DOM，无 react）、页面不可见时轮询自动暂停。

## 功能

| 功能 | 说明 |
|---|---|
| 实时指标 | CPU / MEM / DSK 使用率 + 进度条；网络 下载/上传 速率分行显示、各带独立进度条（按近期峰值缩放）；标题栏负载 + 运行时长 |
| 进程 TOP10 | 鼠标悬停 ↓下载 / ↑上传 行，浮层显示进程网络 TOP10（有字节计数：近 3s 速率均值；无字节计数：自动降级为活跃连接数排序） |
| 拖动 | 按住标题栏拖动，位置持久化（localStorage） |
| 折叠 | 点击标题栏折叠成单行 CPU 条，再点展开 |
| 隐藏/召唤 | 点击 × 隐藏；右下角出现「性能」召唤按钮 |
| 省资源 | 轮询 2s（可见时），标签页隐藏即停；host 侧快照缓存 1s，多次轮询不重复读 `/proc` |

## 架构

```
dsh-sysmon/
|-- src/
|   |-- index.ts        # host 半区：插件入口（cordis apply，注册路由）
|   |-- metrics.ts      # SysmonCollector：/proc + node:os 采集（零依赖，带缓存）
|   |-- routes.ts       # /api/sysmon/snapshot JSON 路由
|   |-- types.ts        # 共享 wire 类型（host + client 共用，纯类型）
|   |-- invariant.ts    # 空 invariant 伴侣（无运行时断言）
|   `-- client/         # 浏览器半区
|       `-- index.ts    # 小悬浮窗（原生 DOM + fetch 轮询，无框架）
|-- scripts/build.sh    # tsc 编译 host + tsdown 打包 client
`-- cordis.patch.yml    # bundle patch：插入 sysmon 插件行
```

### 数据流

```
browser (client.js) ──GET /api/sysmon/snapshot──▶ host (webServer)
      ▲                                               │
      └─────────────── 2s 轮询（可见时）◀──────────────┘
```

## 采集（host，零依赖）

| 指标 | 来源 | 非 Linux 回退 |
|---|---|---|
| CPU | `/proc/stat` jiffies 两次差值 | `os.cpus()` tick 差值 |
| 内存 | `/proc/meminfo` MemAvailable | `os.totalmem()/freemem()` |
| 磁盘 | `fs.statfsSync('/')` | 同左（跨平台） |
| 网络（总速率） | `/proc/net/dev` 字节差值 | 不可用（null） |
| 网络（进程 TOP10） | `ss -tinp`：有字节计数时按速率差（TCP，同用户）；无字节计数的精简 ss 自动降级为按活跃连接数排序 | 不可用（空列表） |
| 负载/运行时长 | `os.loadavg()` / `os.uptime()` | 同左 |

## 安装

```bash
# 从插件目录
dsh plugin --profile web add link:~/project/other/dsh/dsh-sysmon
# 或开发期热注入（免重启）
dev_inject_plugin ~/project/other/dsh/dsh-sysmon
```

## 配置（cordis.yml / patch）

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `cacheMs` | number (100–60000) | `1000` | host 采集缓存间隔（ms） |

## 已知限制

- 磁盘指标为根文件系统（`/`），不列出每个挂载点。
- 网络总速率仅 Linux（依赖 `/proc/net/dev`）。
- 进程级 TOP10 依赖 Linux + iproute2 的 `ss` 命令，且 `ss -p` 非 root 时只能看到**当前用户**的 TCP 连接（UDP 无累计字节计数，不计入）。若本机 `ss` 不输出字节计数（部分精简构建/特殊网络栈，如 TUN 代理环境），自动降级为按**活跃连接数**排序（悬浮提示会标明模式）；`ss` 缺失时该功能静默降级为空列表。
- 悬浮窗为 host 全局（无会话维度），所有界面可见，位置/可见性存浏览器 localStorage。
- client 轮询间隔固定 2s（不开放配置，保持占用最小）。
