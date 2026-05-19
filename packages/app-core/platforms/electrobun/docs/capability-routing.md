# Capability Routing

Capability routing keeps semantic plugin interfaces separate from desktop/system implementation.

```text
Agent
  -> plugin action/provider/service
  -> capability-router runtime service
  -> eliza.runtime broker method
  -> first-party Satellite
```

Plugins do not import Electrobun main-process modules and do not call individual Satellites directly. The desktop router calls runtime methods such as `fs.list`, `fs.readText`, `fs.writeText`, `pty.command.run`, `git.status`, `git.diff`, `git.command.run`, and `model.status`. In Electrobun, `eliza.runtime` forwards those methods to `eliza.fs`, `eliza.pty`, `eliza.git`, or `eliza.local-model`.

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

- `eliza.fs`: local filesystem roots, lists, reads, writes, and search
- `eliza.pty`: terminal sessions and command execution
- `eliza.git`: local repository status, diff, log, and commands
- `eliza.local-model`: desktop model status, catalog, activation, routing, and downloads

`eliza.runtime` remains the broker. Plugins target the router, the router targets `eliza.runtime`, and `eliza.runtime` invokes the concrete Satellite.

## Fallback Behavior

The shared fallback router returns structured `CAPABILITY_UNAVAILABLE` errors. A plugin may keep a safe existing fallback when no router is registered. A plugin should not silently fake successful desktop work when a registered router fails.

## Routed Paths

`plugin-coding-tools` FILE `ls` now prefers `capability-router.fs.list()` when the runtime has a `capability-router` service. FILE read prefers `capability-router.fs.readText()`. FILE write prefers `capability-router.fs.writeText()`. The action still owns:

- the FILE semantic action
- path validation through its sandbox service
- session cwd fallback
- directory-first listing output
- read-state tracking for write/edit safety
- numbered-line output formatting
- secret-pattern rejection before write

For `ls`, the router receives the validated directory path, ignore globs, and the requested listing limit. The effective cap remains governed by `eliza.fs` policy. If the router is absent or explicitly unavailable, the previous local implementation remains the fallback.

Search remains plugin-owned until `eliza.fs` has method parity:

| Path | Required `eliza.fs` parity before routing |
| --- | --- |
| `FILE action=grep` | A first-class search method with regex mode, literal mode, case sensitivity, multiline support, include/exclude glob filters, type filters, VCS/generated exclusion policy, context-before/context-after, head limit, deterministic ordering, structured file/line/column match records, truncation metadata, and explicit unsupported-option errors. The current literal `fs.search` method is not enough. |
| `FILE action=glob` | A first-class glob/find method with cwd/root policy, one or more patterns, hidden/generated/VCS exclusion policy, file/dir/symlink filters, max-results, deterministic recent-file ordering where requested, typed file metadata, truncation metadata, and explicit unsupported-option errors. Directory `fs.list` is not enough. |
| `FILE action=edit` | A first-class edit/patch method with read-state or expected-digest protection, exact old-string replacement, replace-all behavior, ambiguity detection, first-changed-line metadata, secret-pattern rejection, atomic write behavior, and structured patch errors. Generic `fs.writeText` is not enough and must not be used for edit routing. |

`plugin-coding-tools` SHELL now prefers `capability-router.pty.runCommand()` for command execution. The action still owns command parsing, timeout selection, terminal support checks, history recording, and output formatting.

`plugin-coding-tools` WORKTREE now prefers `capability-router.git.commandRun()` for `git worktree add` and `git worktree remove --force`. The action still owns the worktree stack, sandbox root registration, and session cwd transitions.

## Remaining Work

- Route remaining `plugin-coding-tools` edit/search file operations through `eliza.fs` only where the Satellite has matching primitives.
- Route local file reads/search in documents/browser-adjacent plugins through `eliza.fs` where desktop-only.
- Keep GitHub API, provider APIs, app semantics, and voice semantics plugin-owned.
- Decide whether `eliza.computer` is justified before changing computer-use, browser, or native screen/camera/canvas implementation.

## Audited Follow-Up Candidates

The current safe immediate routing set is still `plugin-coding-tools` FILE `ls/read/write`, SHELL, and WORKTREE Git. The next candidates need narrower interfaces before code moves:

| Area | Current owner | Decision |
| --- | --- | --- |
| `plugin-coding-tools` grep/glob | `plugin-coding-tools` | Keep plugin-owned until `eliza.fs` exposes first-class search and glob/find methods with the documented parity. |
| `plugin-coding-tools` edit | `plugin-coding-tools` | Keep plugin-owned until `eliza.fs` exposes a first-class edit/patch method. Do not route through generic `writeText`. |
| `plugin-agent-orchestrator` coding sessions | `plugin-agent-orchestrator` | Keep session, workspace, runner, and credential semantics plugin-owned. Route only low-level process/filesystem work after a coding-session adapter is explicit. |
| `plugin-computeruse` desktop control | `plugin-computeruse` | Keep plugin-owned until a reviewed `eliza.computer` surface exists. Screen, input, windows, clipboard, and app control are not just PTY calls. |
| `plugin-codex-cli` auth files | `plugin-codex-cli` | Keep credential/auth semantics plugin-owned. File access can route later only if credential storage semantics stay intact. |
| `plugin-github` credentials/API | `plugin-github` | Keep connector credentials and GitHub API plugin-owned. Route local repo operations only when they are actual local Git, not GitHub API work. |
