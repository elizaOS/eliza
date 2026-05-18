# E2B Satellite Runner

The E2B path is the first cloud Satellite runner for coding execution. A Satellite is the portable Bun capability worker contract: manifest, typed methods, and event stream. Electrobun is one local runner for that contract; E2B is a cloud runner for the same filesystem, terminal, and Git surface.

Plugins stay semantic:

```text
plugin-coding-tools
  -> capability-router runtime service
  -> E2B Satellite runner
  -> sandbox filesystem / commands / git
```

This keeps TypeScript plugins portable across desktop, cloud, server, and mobile clients. A phone can ask the same Eliza agent to run coding tools without needing Electrobun, local JIT, or host shell access. The route changes by provider, not by plugin semantics:

```text
desktop/native
  plugin-coding-tools -> capability-router -> eliza.runtime -> eliza.pty/eliza.fs/eliza.git

cloud/E2B
  plugin-coding-tools -> capability-router -> E2B Satellite runner -> sandbox pty/fs/git
```

## Activation

Register the E2B Satellite runner with one of:

```text
ELIZA_CODING_SATELLITE_RUNNER=e2b
ELIZA_SATELLITE_RUNNER=e2b
ELIZA_E2B_SATELLITE_RUNNER=1
```

Authentication uses:

```text
E2B_API_KEY
E2B_ACCESS_TOKEN
```

Optional sandbox settings:

```text
E2B_SANDBOX_ID                  connect to an existing sandbox
E2B_TEMPLATE                    create from a specific template
ELIZA_E2B_WORKDIR               sandbox workspace, default /workspace
ELIZA_E2B_HOST_WORKSPACE_ROOT   host path mapped to the sandbox workdir
ELIZA_E2B_BOOTSTRAP_GIT_URL     clone a repo into the sandbox workdir
ELIZA_E2B_BOOTSTRAP_GIT_REF     checkout a branch, tag, or commit
ELIZA_E2B_KEEP_ALIVE=1          keep created sandbox alive on service stop
ELIZA_E2B_TIMEOUT_MS            sandbox and command timeout
ELIZA_E2B_REQUEST_TIMEOUT_MS    SDK request timeout
```

## Routing

Mapped capabilities:

| Capability | Route |
| --- | --- |
| `fs.list` | E2B `sandbox.files.list()` |
| `fs.readText` | E2B `sandbox.files.read()` |
| `fs.writeText` | E2B `sandbox.files.write()` |
| `pty.command.run` | E2B `sandbox.commands.run()` |
| `git.status` | `git status --porcelain=v1 --branch` in sandbox |
| `git.diff` | `git diff` in sandbox |
| `git.command.run` | `git ...args` in sandbox |

`model.status` remains unavailable because local model control belongs to local-model providers, not the coding Satellite runner.

## Workspace Mapping

Absolute host paths under `ELIZA_E2B_HOST_WORKSPACE_ROOT` map into `ELIZA_E2B_WORKDIR`.

Example:

```text
ELIZA_E2B_HOST_WORKSPACE_ROOT=/Users/me/eliza
ELIZA_E2B_WORKDIR=/workspace

/Users/me/eliza/packages/agent -> /workspace/packages/agent
```

Paths outside the mapped root fail with `CAPABILITY_UNAVAILABLE`. This prevents a cloud sandbox from pretending it can reach arbitrary host paths.

## Mobile And Cross-Device

The mobile app does not run Electrobun. It talks to the same Eliza agent runtime. When coding tools need filesystem, terminal, or Git execution, the runtime service can route to a reachable Satellite provider:

- native desktop provider when the user has a paired desktop host
- E2B cloud provider when the user needs sandboxed build/run capacity
- future bare Bun or Docker provider when those are registered

Results stream back through normal chat, trace, or dynamic-view channels.

## Review Boundary

This is the first E2B slice:

- E2B SDK installed in `packages/agent`.
- Agent runtime can register an E2B Satellite runner as the `capability-router` service.
- `plugin-coding-tools` SHELL no longer blocks cloud mode before the router can run.
- Existing plugin fallback behavior remains when no router is registered or when E2B is unavailable.

Not included yet:

- browser preview proxying from sandbox ports into dynamic views
- workspace upload/sync beyond optional Git bootstrap
- artifact publishing
- long-lived per-user sandbox registry
- permission UI
