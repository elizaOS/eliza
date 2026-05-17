# Capability Routing

Capability routing keeps semantic plugin interfaces separate from desktop/system implementation.

```text
Agent
  -> plugin action/provider/service
  -> capability-router runtime service
  -> eliza.runtime broker method
  -> first-party Satellite
```

Plugins do not import Electrobun main-process modules and do not call individual Satellites directly. The desktop router calls runtime methods such as `fs.readText`, `pty.command.run`, `git.status`, `git.diff`, `git.command.run`, and `model.status`. In Electrobun, `eliza.runtime` forwards those methods to `eliza.fs`, `eliza.pty`, `eliza.git`, or `eliza.local-model`.

## Plugin Layer

Plugins keep meaning:

- connector protocols and remote APIs
- model/provider semantics
- app/plugin product semantics
- voice-mode semantics
- coding/document/workflow actions the agent can understand

Implementation-only desktop paths can collapse behind the router without deleting the plugin action.

## Satellite Layer

Satellites keep desktop/system implementation:

- `eliza.fs`: local filesystem roots, reads, writes, and search
- `eliza.pty`: terminal sessions and command execution
- `eliza.git`: local repository status, diff, log, and commands
- `eliza.local-model`: desktop model status, catalog, activation, routing, and downloads

`eliza.runtime` remains the broker. Plugins target the router, the router targets `eliza.runtime`, and `eliza.runtime` invokes the concrete Satellite.

## Fallback Behavior

The shared fallback router returns structured `CAPABILITY_UNAVAILABLE` errors. A plugin may keep a safe existing fallback when no router is registered. A plugin should not silently fake successful desktop work when a registered router fails.

## Routed Paths

`plugin-coding-tools` FILE read now prefers `capability-router.fs.readText()` when the runtime has a `capability-router` service. The action still owns:

- the FILE semantic action
- path validation through its sandbox service
- read-state tracking for write/edit safety
- numbered-line output formatting

If the router is absent or explicitly unavailable, the previous local implementation remains the fallback.

`plugin-coding-tools` SHELL now prefers `capability-router.pty.runCommand()` for command execution. The action still owns command parsing, timeout selection, terminal support checks, history recording, and output formatting.

`plugin-coding-tools` WORKTREE now prefers `capability-router.git.commandRun()` for `git worktree add` and `git worktree remove --force`. The action still owns the worktree stack, sandbox root registration, and session cwd transitions.

## Remaining Work

- Route remaining `plugin-coding-tools` write/edit/search file operations through `eliza.fs` where the Satellite has matching primitives.
- Route local file reads/search in documents/browser-adjacent plugins through `eliza.fs` where desktop-only.
- Keep GitHub API, provider APIs, app semantics, and voice semantics plugin-owned.
- Decide whether `eliza.computer` is justified before changing computer-use, browser, or native screen/camera/canvas implementation.
