# Tencent EdgeOne MCP

A local stdio MCP server for managing the Tencent EdgeOne Zones visible to a CAM identity. It supports Zone discovery, L7 rule listing and management, cache purges, and purge-task status. Every per-Zone call checks that Tencent returns the requested `zoneId` for the configured identity. The server does not expose arbitrary TEO API calls or wildcard Zone operations.

## Requirements

- Windows 10/11 with Windows PowerShell 5.1
- Node.js 24 or newer
- pnpm
- A dedicated Tencent Cloud CAM identity with the TEO permissions needed for the tools you plan to use

Use a dedicated CAM identity with the narrowest permissions practical. Do not use a Tencent Cloud root key. Available API actions are `teo:DescribeZones`, `teo:DescribeL7AccRules`, `teo:CreateL7AccRules`, `teo:ModifyL7AccRule`, `teo:DeleteL7AccRules`, `teo:ModifyL7AccRulePriority`, `teo:CreatePurgeTask`, and `teo:DescribePurgeTasks`.

## Install

Clone the repository, enter its directory, and install the pinned dependencies:

```powershell
git clone https://github.com/duanap/edgeone-mcp.git
cd edgeone-mcp
pnpm install --frozen-lockfile
```

## Save your Tencent credentials

Run this in a visible PowerShell window. SecretId and SecretKey are entered with hidden prompts and encrypted with Windows DPAPI for the current Windows user. The encrypted file is stored outside the project under `%LOCALAPPDATA%\Codex\edgeone-mcp`. Each person must enter their own credentials on their own Windows account; another user cannot reuse your DPAPI file.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\save-credentials.ps1
```

The execution-policy override applies to this one command only. Never paste credentials into chat or store them in source code, `.env`, or Codex config.

Verify the saved credentials and list the Zones visible to that CAM identity:

```powershell
node .\src\bootstrap.mjs --verify
```

This verification is read-only.

## Register in Codex

Edit your user-level Codex `config.toml` and add the following. Replace the example path with the full path to the cloned project's `src/bootstrap.mjs` file. Forward slashes work in Windows TOML paths.

```toml
[mcp_servers.edgeone]
command = "node"
args = ["C:/path/to/edgeone-mcp/src/bootstrap.mjs"]
```

Restart Codex or open a fresh local Codex session to load the MCP. This server runs locally and is not automatically available to remote/cloud Codex sessions.

Start with `edgeone_list_zones`. Pass one of its returned `zoneId` values to `edgeone_list_l7_rules` or another per-Zone tool.

## Available tools

- `edgeone_list_zones`
- `edgeone_list_l7_rules`
- `edgeone_create_l7_rule`
- `edgeone_modify_l7_rule`
- `edgeone_delete_l7_rules`
- `edgeone_reorder_l7_rules`
- `edgeone_purge_cache`
- `edgeone_list_purge_tasks`

Rule creation or modification can change live traffic. Deletion, rule reordering, and cache purges can have broad effects; review the exact Zone and operation and obtain approval before invoking them. `purge_all` clears cache across the selected Zone. Sensitive header values in rule reads are redacted.

## Development

Run the test suite with:

```powershell
pnpm test
```

Tests use fake clients and temporary credentials; they do not call live EdgeOne write APIs.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
