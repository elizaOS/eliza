# @elizaos/soc2-verify

SOC2 control-verification harness for the elizaOS monorepo. Runs static
(file/config inspection) and dynamic (live code round-trip) checks and emits a
JSON + Markdown evidence report for auditor sampling.

## What it does

- Checks 27 controls across SOC2 Trust Service Criteria: CC4, CC6, CC7, CC8, C1, PI1.
- Static checks inspect filesystem layout, GitHub Actions workflows, k8s manifests,
  database schema patterns, and git history (via gitleaks when installed).
- Dynamic checks instantiate real `@elizaos/security` adapters to prove KMS
  AEAD encrypt/decrypt, HMAC sign/verify, Ed25519 sign/verify, and audit-event
  dispatch all work correctly at runtime.
- Writes two files: `evidence-report.json` (machine-readable) and
  `evidence-report.md` (human-readable).

## Usage

```bash
# Run all checks, write report to .soc2-evidence/<timestamp>/
bun run packages/soc2-verify/src/cli.ts

# Write to a specific directory; exit non-zero if any critical check fails
bun run packages/soc2-verify/src/cli.ts --strict-fail --out .soc2-evidence

# Run only checks whose id contains "CC8.1"
bun run packages/soc2-verify/src/cli.ts --include CC8.1

# Or use the package scripts
bun run --cwd packages/soc2-verify verify
bun run --cwd packages/soc2-verify verify:strict
```

## CLI options

| Flag | Description |
| --- | --- |
| `--out <dir>` | Output directory. Default: `.soc2-evidence/<timestamp>`. |
| `--strict-fail` | Exit non-zero if any `critical`-severity check fails. |
| `--include <substr>` | Only run checks whose id contains `<substr>`. Repeatable. |
| `-h, --help` | Print usage. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `SOC2_OUTER_ROOT` | Override workspace root for outer-repo checks (`.github/workflows`, etc.). |
| `SOC2_GITLEAKS_LOG_OPTS` | git log range for `gitleaks detect`. Default: `--all`. |

## Readiness score

`pass / (pass + fail)` — excludes `warn` and `skip`. Displayed as a percentage
in the CLI summary and the report.

## Notes

- Private package — not published to npm.
- No build step: source files run directly under Bun (Node >= 24 required).
- If `gitleaks` is not installed, the secret-scan check returns `skip`; install
  with `brew install gitleaks` for local runs.

See `packages/soc2-verify/CLAUDE.md` for agent-oriented layout and extension guide.
