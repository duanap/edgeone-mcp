# 腾讯云 EdgeOne MCP

这是一个运行在本机的 stdio MCP 服务，可让 Codex 等 MCP 客户端管理腾讯云 CAM 身份有权访问的 EdgeOne Zone。支持查询 Zone、读取和管理七层规则、清理缓存，以及查询清理任务状态。

每次针对 Zone 的操作都会先确认该 `zoneId` 对当前 CAM 身份可见。服务不提供任意 TEO API 转发，也不支持通配符 Zone 操作。读取规则时会隐藏敏感请求头的值。

## 环境要求

- Windows 10/11 和 Windows PowerShell 5.1
- Node.js 24 或更高版本
- pnpm
- 一个具有所需 TEO 权限的腾讯云 CAM 身份

建议为此服务创建专用 CAM 身份，并只授予实际需要的权限。不要使用腾讯云主账号密钥。服务可能调用的 API 权限包括：

`teo:DescribeZones`、`teo:DescribeL7AccRules`、`teo:CreateL7AccRules`、`teo:ModifyL7AccRule`、`teo:DeleteL7AccRules`、`teo:ModifyL7AccRulePriority`、`teo:DescribeContentQuota`、`teo:CreatePurgeTask`、`teo:DescribePurgeTasks`。

## 安装

在 PowerShell 中克隆仓库并安装锁定版本的依赖：

```powershell
git clone https://github.com/duanap/edgeone-mcp.git
cd edgeone-mcp
pnpm install --frozen-lockfile
```

确认命令可用：

```powershell
node --version
pnpm --version
```

## 配置腾讯云凭据

在**当前 Windows 用户的 PowerShell 窗口**中运行凭据保存脚本。按提示输入 SecretId 和 SecretKey；输入过程不会显示密钥。脚本使用 Windows DPAPI 为当前用户加密凭据，并将文件保存在项目目录之外：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\save-credentials.ps1
```

`-ExecutionPolicy Bypass` 只对这次命令生效。凭据文件位于 `%LOCALAPPDATA%\Codex\edgeone-mcp\credentials.dpapi.json`。DPAPI 文件只能由创建它的 Windows 用户解密；其他 Windows 用户需要各自运行脚本录入凭据。

不要把密钥粘贴到聊天中，也不要将密钥写入源代码、`.env` 文件或 Codex 配置。

### 验证凭据和权限

运行只读验证，并列出该 CAM 身份可访问的 Zone：

```powershell
node .\src\bootstrap.mjs --verify
```

验证只查询 Zone，不会修改规则或清理缓存。如果验证失败，请检查凭据是否由当前 Windows 用户保存，以及 CAM 身份是否有 `teo:DescribeZones` 权限。

## 在 Codex 中配置

打开用户级 Codex 配置文件 `%USERPROFILE%\.codex\config.toml`，添加以下配置。将示例路径替换为本机仓库中 `src/bootstrap.mjs` 的完整路径；TOML 中 Windows 路径可以使用正斜杠：

```toml
[mcp_servers.edgeone]
command = "node"
args = ["C:/path/to/edgeone-mcp/src/bootstrap.mjs"]
```

保存后重启 Codex，或新建一个本机 Codex 会话以加载 MCP 服务。该服务运行在本机，不会自动提供给远程或云端 Codex 会话。运行服务的 Windows 用户必须与保存 DPAPI 凭据的用户相同。

## 使用方法

MCP 加载后，先调用 `edgeone_list_zones` 查看当前身份有权限访问的 Zone。然后把返回结果中的 `zoneId` 提供给其他 Zone 工具。例如，可以在 Codex 中这样提出请求：

- “列出我有权限访问的 EdgeOne Zone。”
- “查询 `zone-xxxx` 的七层规则。”
- “查询 `zone-xxxx` 最近一小时的缓存清理任务。”
- “在 `zone-xxxx` 清理 `https://example.com/assets/app.css` 的缓存。”

写操作会影响线上流量或缓存。执行创建、修改、删除、规则排序或缓存清理前，应先核对目标 Zone 和具体参数，并明确批准该操作；`purge_all` 会清理所选 Zone 的全部缓存。

### 可用工具

| 工具 | 用途 | 主要参数 |
| --- | --- | --- |
| `edgeone_list_zones` | 列出当前 CAM 身份可访问的 Zone | 无 |
| `edgeone_list_l7_rules` | 查询指定 Zone 的七层规则 | `zoneId` |
| `edgeone_create_l7_rule` | 在指定 Zone 创建七层规则 | `zoneId`、`rule` |
| `edgeone_modify_l7_rule` | 替换指定规则 | `zoneId`、`ruleId`、`rule` |
| `edgeone_delete_l7_rules` | 删除指定规则 | `zoneId`、`ruleIds`（1–50 个） |
| `edgeone_reorder_l7_rules` | 调整该 Zone 全部规则的执行顺序 | `zoneId`、`ruleIds`（按期望顺序列出全部规则 ID） |
| `edgeone_purge_cache` | 在指定 Zone 创建缓存清理任务 | `zoneId`、`type`，以及按类型需要的 `targets`；部分类型可选 `method` |
| `edgeone_list_purge_tasks` | 查询缓存清理任务 | `zoneId`，以及 `jobId` 或 `startTime` 和 `endTime` |
| `edgeone_get_content_quota` | 查询免费版支持的缓存清理额度 | `zoneId` |

`rule` 应使用腾讯云 TEO 七层规则 API 所需的规则对象。创建或修改时请先读取当前规则，并依据腾讯云 API 对应字段提供完整、准确的规则内容。

免费版模式下，缓存清理只支持以下 `type`。每次提交前，服务会通过 `DescribeContentQuota` 查询该 Zone 当前额度，并在请求超过单次额度、日剩余额度或类型没有可用配额时拒绝提交。额度会随套餐、站点和使用情况变化，因此以接口实时返回值为准。

- `purge_url`：清理指定 URL，`targets` 为完整的 `http` 或 `https` URL。
- `purge_prefix`：清理指定 URL 前缀，`targets` 为完整 URL。
- `purge_host`：清理指定主机，`targets` 为主机名。
- `purge_all`：清理整个 Zone，不需要 `targets`。

免费版不支持 Cache-Tag 清理或 URL 预热。查询 `edgeone_get_content_quota` 可查看清理类型、单次上限、每日上限和每日剩余额度。`targets` 最多 100 项；`method` 可设为 `invalidate` 或 `delete`，适用于 `purge_prefix`、`purge_host` 和 `purge_all`。查询任务时，`jobId` 与 `startTime`/`endTime` 二选一；时间范围必须有效且开始时间早于结束时间。

## 开发与测试

运行测试：

```powershell
pnpm test
```

测试使用模拟客户端和临时凭据，不会调用 EdgeOne 线上写入 API。

## 故障排查

- **Codex 中看不到工具：**检查 `config.toml` 中的 `src/bootstrap.mjs` 路径，然后重启 Codex 或新建本机会话。
- **启动时提示没有凭据：**在保存凭据的同一个 Windows 用户下运行 Codex，并重新运行凭据保存脚本。
- **API 返回权限错误：**为 CAM 身份添加对应操作所需的最小 TEO 权限。
- **想先确认账号可访问范围：**运行 `node .\src\bootstrap.mjs --verify`；该命令只读。

## 许可证

本项目使用 MIT 许可证，详见 [LICENSE](LICENSE)。
