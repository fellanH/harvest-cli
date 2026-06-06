---
node: domain
status: live
---
# harvest-cli connector

Harvest API v2 CLI for omni time-reporting. Reads auth from `~/.omni/secrets.json` (`HARVEST_TOKEN`, `HARVEST_ACCOUNT_ID`).

## Boot

```
chad harvest-cli
```

## Usage

```
npx tsx cli.ts <command>
```

Commands: `projects`, `log`, `entries`, `today`, `week`.

## Conventions

- Single-file TypeScript CLI (`cli.ts`). No build step — run via `npx tsx`.
- Auth secrets at `~/.omni/secrets.json` (never commit).
- This is a standalone connector extracted from omni-system `packages/harvest-cli` (2026-06-05).
