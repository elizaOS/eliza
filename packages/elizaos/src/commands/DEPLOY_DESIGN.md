# `elizaos deploy` — Deployment Plan Preview

`elizaos deploy` is a side-effect-free planning command. It prints the Eliza
Cloud deployment sequence for the current project and exits without network
calls, filesystem writes, or local builds.

The CLI does not deploy directly to Vercel and does not own Eliza Cloud
credentials. Authenticated build orchestration, linked GitHub repositories,
Vercel projects, app subdomains, and custom-domain attachment are Eliza Cloud
dashboard responsibilities.

## Command Surface

```bash
elizaos deploy [--app-id <id>] [--domain <host>] [--dry-run] [--verbose]
```

- `--app-id <id>` — app id to substitute into the printed plan. When omitted,
  the plan shows that the id must be resolved from project metadata or cloud
  app selection.
- `--domain <host>` — custom hostname to include in the printed domain step.
  The CLI validates the hostname shape before printing the plan.
- `--dry-run` — accepted for compatibility. The command is always a preview.
- `--verbose` — prints resolved inputs to stderr before the plan.

## Printed Plan

The plan is deterministic and contains these steps:

1. auth check
2. app lookup
3. build
4. upload
5. register app deploy
6. attach domain, skipped when `--domain` is omitted
7. poll status
8. print URL

These steps describe the cloud-side deployment workflow a user should run from
Eliza Cloud. They are not local CLI actions.

## Validation And Exit Codes

- Invalid `--domain` exits `1` and prints the validation error to stderr.
- Valid inputs print the plan and exit `0`.
- No command path performs deployment side effects.
