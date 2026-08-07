# eliza-cloud-agent

Minimal deployment entrypoint for the managed cloud-agent image.

## Role

This workspace package exists so deployment tooling can install a small, explicit dependency set and start an Eliza cloud agent with `tsx entrypoint.ts`. The entrypoint delegates all boot behavior to `../cloud-agent-shared.ts`; do not fork authentication, plugin assembly, runtime lifecycle, or shutdown logic into this template.

The dependency list is part of the deployment contract. Keep only runtime packages required by the shared cloud agent: core, SQL storage, Eliza Cloud integration, workflow support, and the TypeScript launcher.

## Files

```
entrypoint.ts   imports and starts the shared cloud-agent bootstrap
package.json    image/runtime dependency boundary and start command
```

## Command

```bash
bun run --cwd packages/app-core/deploy/cloud-agent-template start
```

This command expects the surrounding app-core deployment layout because the entrypoint imports `../cloud-agent-shared.ts`.

## Change rules

- Put shared cloud-agent behavior in `packages/app-core/deploy/cloud-agent-shared.ts`.
- Keep this entrypoint free of route, model, storage, or auth policy.
- When adding a shared bootstrap dependency, update this manifest and the deployment/image verification that installs it.
- Fail boot when the shared runtime cannot initialize; do not turn deployment failures into a nominally running process.

## Verification

Follow the [app-core guide](../../CLAUDE.md) and the repository-wide standard in the [root CLAUDE.md](../../../../CLAUDE.md). Build the actual cloud-agent image or equivalent deployment artifact and inspect startup, plugin registration, persistence, logs, and shutdown behavior.

