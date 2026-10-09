# Codex Cloud setup for edgeone-mcp

Use this branch to prepare an isolated development environment for `duanap/edgeone-mcp`.

- Migration branch: `codex/cloud-migration/2026-10-09`
- Source baseline: `fe6e67cbceaa6a77d9fbfccb2bf2e9a427dce0e7`
- Runtime: Node.js {"node": ">=24"}
- Setup status: repository and command inspection complete; cloud installation and runtime checks pending.

## Install dependencies

Run from the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Check the environment

Run the applicable checks and record their actual results:

```bash
pnpm run test
```

## Start development

Run in the development environment:

```bash
pnpm run start
```

Check the documented local health endpoint or page after startup.

## Configuration and work boundaries

- Read the existing `AGENTS.md` and README before changing behavior.
- Put credentials in cloud environment configuration; keep `.env`, private keys, production databases, uploads, and dependency directories out of commits.
- Use synthetic development data. Production deployment and production database operations require a separate request.
- Keep existing APIs, game rules, and authentication behavior.
- Use local checks. Do not add CI or paid GitHub features for this migration.
- Preserve focused branches; do not force-push or overwrite the default branch.

- The Windows DPAPI credential store from the original computer is not portable. Configure development credentials using the supported runtime options; never upload the original credential file.

See the [official cloud environment guide](https://learn.chatgpt.com/docs/environments/cloud-environments) for environment publication and credentials.
