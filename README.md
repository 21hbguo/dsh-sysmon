# dsh-sysmon — DSH 系统性能看板（小悬浮窗）

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web GUI 提供右下角小悬浮窗，实时展示本机 CPU / 内存 / 磁盘 / 网络 / 负载 / 运行时长 / GPU。占用极小：host 采集零第三方依赖（`/proc` + `node:os`），client 零框架（原生 DOM，无 react），页面不可见时轮询自动暂停。

![version](https://img.shields.io/badge/version-0.1.0-4f8ef7) ![license](https://img.shields.io/badge/license-BSD--3--Clause-9b59b6) ![platform](https://img.shields.io/badge/platform-DSH%20Web-00c2a8)

![系统性能悬浮窗：CPU / 内存 / 磁盘 / 网络 / 负载实时监控](docs/screenshots/sysmon-widget.png)

## ✨ 功能特性

| 功能 | 说明 |
|---|---|
| 实时指标 | CPU / MEM / 磁盘 / GPU 使用率 + 进度条；网络 ↓下载 / ↑上传 速率分行显示，各带独立进度条（按近期峰值自动缩放） |
| 进程网络 TOP10 | 悬停 ↓下载 / ↑上传 行，浮层显示进程网络 TOP10（有字节计数：近 3s 速率均值 + EMA 平滑；无字节计数：自动降级为按活跃连接数排序） |
| 磁盘多挂载点 | 物理挂载点全部列出（根优先、按已用降序，最多 6 个），过滤 proc/sysfs/tmpfs 等虚拟文件系统 |
| GPU 支持 | AMD 直接读 sysfs（零子进程）；NVIDIA 走 `nvidia-smi`（后台异步采样，不阻塞事件循环） |
| 拖动 / 折叠 / 隐藏 | 按住标题栏拖动，位置持久化（localStorage）；点击标题折叠成单行；× 隐藏后右下角出现「性能」召唤按钮 |
| 省资源 | client 轮询 2s（仅页面可见时，标签页隐藏即停）；host 快照缓存 `cacheMs`，多次轮询不重复读 `/proc` |

## 📐 架构

```
dsh-sysmon/
|-- src/
|   |-- index.ts        # host 半区：插件入口（cordis apply，注册设置命名空间 + 路由）
|   |-- metrics.ts      # SysmonCollector：/proc + node:os + statfs 采集（零依赖，带缓存）
|   |-- routes.ts       # GET /api/sysmon/snapshot JSON 路由
|   |-- types.ts        # 共享 wire 类型（host + client 共用，纯类型）
|   |-- invariant.ts    # 空 invariant 伴侣（无运行时断言）
|   `-- client/         # 浏览器半区
|       |-- index.ts    # 小悬浮窗（原生 DOM + fetch 轮询，无框架）
|       `-- PluginSettingsCard.tsx / settings-form.ts  # 设置卡片（settings.plugin.item 槽位）
|-- scripts/build.sh    # 用 DSH 检出的 tsc 编译 host + tsdown 打包 client
|-- cordis.patch.yml    # bundle patch：插入 sysmon 插件行
`-- tsdown.config.ts    # client 打包配置（react / dsh 客户端表面为外部依赖）
```

```mermaid
flowchart LR
    subgraph browser[浏览器 · DSH Web GUI]
        W[悬浮窗 client.js<br/>原生 DOM + fetch]
        C[设置卡片<br/>settings.plugin.item]
    end
    subgraph host[宿主进程]
        R[GET /api/sysmon/snapshot]
        S[SysmonCollector<br/>cacheMs 缓存]
        P[/proc + node:os + statfs]
        SS[后台采样<br/>ss -tinp 每 3s]
        NV[后台采样<br/>nvidia-smi 每 5s]
    end
    W -- 2s 轮询（仅可见时） --> R
    R --> S
    S --> P
    S --> SS
    S --> NV
    C -- 读写 settings 命名空间 sysmon --> S
```

**数据流**：浏览器半区每 2s（页面可见时）向同源端点 `GET /api/sysmon/snapshot` 拉取一次快照；host 侧 `SysmonCollector` 至少缓存 `cacheMs` 才重算一次，CPU / 网络速率按两次采样差值计算，进程级网络与 GPU 由后台异步采样器维护，绝不阻塞事件循环。

## 🚀 快速开始

### 前提

- 一台运行 **DeepSeek Harness** 的环境（本插件是 DSH 插件，必须运行在 DSH 进程内，无法独立使用）。
- 从源码构建时需要一份 **DSH 源码检出**（含已安装的 `node_modules`，构建脚本会使用其中的 `tsc` / `tsdown`）；也可以直接使用本仓库 Release 里构建好的 tgz。

### 安装

**方式 A：源码构建 + link 装配**

```bash
# 1. 获取代码
git clone https://github.com/21hbguo/dsh-sysmon.git
cd dsh-sysmon

# 2. 构建（lib/ 与 node_modules/ 均为 .gitignore 忽略的构建产物，不入库）
DSH_CHECKOUT=/path/to/dsh-source-checkout bash scripts/build.sh
# DSH_CHECKOUT 也可省略，脚本会自动探测 ~/dsh-harness、~/dsh、~/.dsh/dsh-harness

# 3. 装配到 DSH web profile（link 方式，从插件目录引用）
dsh plugin --profile web add link:/absolute/path/to/dsh-sysmon
```

**方式 B：开发期热注入（免重启）**

在 DSH 会话中使用超级模组注入器，运行时注入即生效，卸载即净：

```
dev_inject_plugin /absolute/path/to/dsh-sysmon
```

**方式 C：Release bundle 包**

下载 [Releases](../../releases) 中的 `dsh-sysmon-0.1.0.tgz`，作为 bundle 包装配（与 dsh-web-ui 家族插件一致），装配时应用仓库内的 `cordis.patch.yml` 插入插件行（id：`sysmon`，包名：`@dsh-external/dsh-sysmon`）。

### 验证

1. 刷新 Web GUI 页面。
2. 右下角出现「性能」悬浮窗：CPU / 内存 / 磁盘 / 网络各行实时跳动，标题栏显示「性能 · 负载（1/5/15 分钟）· 运行时长」。
3. 悬停 ↓下载 / ↑上传 行出现进程网络 TOP10 浮层；点击标题可折叠，拖动标题栏可移动位置。
4. 可选：打开 **设置 → 插件 → 系统性能看板**，可开关 `enabled`、调整 `cacheMs` 采集间隔。

### 排错表

| 现象 | 原因 | 解决 |
|---|---|---|
| 右下角没有悬浮窗 | 插件未装配，或设置 `enabled` 为关 | 确认插件行已装配（link / bundle / 注入）；设置页 → 系统性能看板 → 启用 |
| 悬浮窗显示 `offline` | 快照路由不可达（host 重启中、路由未注册） | 等待下一个 2s 轮询自动恢复；确认插件已启用 |
| 网络速率显示 `--` | 非 Linux 平台 | 网络总速率仅 Linux 支持（依赖 `/proc/net/dev`） |
| 进程 TOP10 显示「活跃连接」而非速率 | 本机 `ss` 为精简构建，无字节计数 | 正常降级行为，无需处理 |
| GPU 行不出现 | 非 AMD / NVIDIA，或驱动工具缺失 | 静默降级为不显示，不影响其他指标 |
| 构建报 `cannot locate the dsh checkout` | 未设置 `DSH_CHECKOUT` 且常见路径无 DSH 检出 | `export DSH_CHECKOUT=/path/to/dsh-source-checkout` 后重跑 |
| 设置卡片提示「未向设置页暴露」 | 部署的 DSH 版本未把 `sysmon` 命名空间加入设置白名单 | 编辑 `~/.dsh/settings.yaml` 直接配置，或为 `dsh-host-apiproxy` 的 `WEB_SETTINGS_NAMESPACES` 白名单补充 `sysmon` 后重启 |

## ⚙️ 配置项

通过设置页「系统性能看板」卡片（settings 命名空间 `sysmon`）或 `cordis.yml` / patch 配置：

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关；关闭后停用快照路由、隐藏悬浮窗并停止采集 |
| `cacheMs` | number | `2000` | host 两次采集之间的最小间隔（100–60000，步长 100） |

**固定参数**（不开放配置，保持占用最小）：client 轮询 2s（仅页面可见时）、`ss -tinp` 进程网络采样 3s、GPU 采样 5s、进程网络 TOP10 上限 10、磁盘挂载点上限 6、窗口位置默认距视口右下角 16/20px（localStorage 键 `dsh.sysmon.ui.v1`）。

### 采集数据来源

| 指标 | 来源（Linux） | 非 Linux 回退 |
|---|---|---|
| CPU | `/proc/stat` jiffies 两次差值 | `os.cpus()` tick 差值 |
| 内存 | `/proc/meminfo` MemAvailable | `os.totalmem()/freemem()` |
| 磁盘 | `/proc/mounts` + `statfs`（物理挂载点，根优先） | `statfs('/')` |
| 网络（总速率） | `/proc/net/dev` 非回环字节差值 | 不可用（null） |
| 网络（进程 TOP10） | `ss -tinp`：有字节计数按速率差（TCP，同用户）；无字节计数自动降级为按活跃连接数排序 | 不可用（空列表） |
| 进程数 | `/proc` 数字目录计数 | 不可用（null） |
| GPU | AMD sysfs 直接读（零子进程）/ NVIDIA `nvidia-smi`（异步 5s） | 不可用（null） |
| 负载 / 运行时长 | `os.loadavg()` / `os.uptime()` | 同左 |

## 🔐 安全说明

- **只采集系统指标**：不读取任何文件内容、密钥、浏览器数据或会话数据。
- **无遥测、无外联**：唯一的网络活动是浏览器向 DSH 同源端点 `GET /api/sysmon/snapshot` 拉取快照。
- **快照端点无鉴权**（与 DSH Web 同源），请勿将 DSH 直接暴露到公网。
- **进程级网络信息仅限当前用户**：`ss -p` 在非 root 下只能看到当前用户的 TCP 连接；进程名会显示在悬浮窗浮层中。
- **localStorage 只存窗口位置与可见性**（键 `dsh.sysmon.ui.v1`），无其他持久化。

## ❓ 常见问题

**Q：非 Linux 系统能用吗？**
能用，能力部分降级：CPU / 内存 / 磁盘 / 负载 / 运行时长跨平台可用；网络总速率、进程网络 TOP10、进程数仅 Linux 支持；GPU 依赖驱动工具存在。

**Q：为什么进程网络 TOP10 显示的是「活跃连接」而不是速率？**
部分精简构建 / 特殊网络栈（如 TUN 代理环境）的 `ss` 不输出累计字节计数，无法计算速率差，插件自动降级为按活跃 TCP 连接数排序，浮层标题会标明当前模式。

**Q：GPU 行一直不出现？**
仅 AMD（sysfs）与 NVIDIA（`nvidia-smi` 可用时）会显示；其他 GPU 或无驱动环境静默降级，不影响其余指标。

**Q：悬浮窗位置丢了 / 想重置？**
位置与可见性存在浏览器 localStorage（键 `dsh.sysmon.ui.v1`），清除站点数据即可重置。

**Q：`npm install` 时提示找不到 `@deepseek-ai/*`？**
`@deepseek-ai/*` 是 DSH 内部包（不在公共 npm 注册表），已在 `peerDependenciesMeta` 中标为 optional——外部安装不会失败；在 DSH 宿主环境中由宿主提供，无需手动安装。

## 📄 License

[BSD-3-Clause](./LICENSE) © 2026 21hbguo
