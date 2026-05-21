# @elizaos/soc2-verify

SOC2 control-verification harness. Runs static (file/config inspection) and
dynamic (round-trip code) checks against the Eliza monorepo and emits a JSON +
Markdown evidence report for auditor sampling.

Run:

```
bun run packages/soc2-verify/src/cli.ts
bun run packages/soc2-verify/src/cli.ts --strict-fail --out .soc2-evidence
```

See `docs/security/EVIDENCE.md` for the auditor sampling protocol.
