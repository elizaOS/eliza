# Capability Collapse Matrix

This matrix tightens the convergence audit by separating semantic plugin interfaces from desktop implementation paths. The rule is: collapse implementation, not meaning.

## Executive Summary

Plugins remain the elizaOS runtime extension layer. They own agent-facing actions, providers, services, routes, events, model handlers, connector semantics, and app/product semantics.

Satellites own desktop/system implementation behind the Electrobun host boundary. A plugin should use a shared capability router when it needs local filesystem, terminal, local Git, or local model host coordination in the desktop shell. The router targets `eliza.runtime`, and `eliza.runtime` brokers to the concrete Satellite.

The first implemented routes are narrow `plugin-coding-tools` paths: FILE ls/read/write prefers `eliza.fs`, SHELL command execution prefers `eliza.pty`, and WORKTREE local Git helpers prefer `eliza.git` through the shared capability router. If the router is absent or explicitly unavailable, the existing local implementation remains the fallback.

## Collapse Immediately Candidates

| Plugin | Capability | Route | Mode | Risk |
| --- | --- | --- | --- | --- |
| `plugin-coding-tools` | filesystem list/read/write | `eliza.fs` | facade-over-satellite | low |
| `plugin-coding-tools` | terminal | `eliza.pty` | facade-over-satellite | medium |
| `plugin-coding-tools` | local Git | `eliza.git` | facade-over-satellite | medium |

These implementation paths are intentionally narrow. The FILE, SHELL, and WORKTREE actions still own agent-facing semantics, policy, output formatting, history/session state, secret rejection, and worktree stack behavior. Host filesystem, terminal, and local Git execution can come from Satellites through the capability router.

## Facade-Over-Satellite Candidates

| Plugin | Capability | Route | Notes |
| --- | --- | --- | --- |
| `plugin-codex-cli` | filesystem | `eliza.fs` | Auth/config files are implementation details. |
| `plugin-codex-cli` | terminal | `eliza.pty` | CLI process execution belongs behind PTY in desktop mode. |
| `plugin-commands` | terminal | `eliza.pty` | Command semantics remain plugin-owned. |
| `plugin-github` | local Git | `eliza.git` | GitHub API remains plugin-owned; local repo work routes to Git. |
| `plugin-documents` | local files | `eliza.fs` | RAG/document semantics remain plugin-owned. |
| `plugin-local-inference` | desktop model control | `eliza.local-model` | Provider runtime remains plugin-owned; desktop control routes through the Satellite. |
| `plugin-browser` | packaging/artifact filesystem | `eliza.fs` | Browser bridge semantics remain plugin-owned. |

## Keep Plugin-Owned Candidates

| Plugin | Capability | Reason |
| --- | --- | --- |
| `plugin-github` | GitHub API | External connector semantics stay in the connector. |
| `plugin-documents` | document/RAG semantics | App/plugin semantics stay in the plugin. |
| `plugin-local-inference` | model provider/runtime | Actual provider runtime stays plugin-owned. |
| `plugin-native-talkmode` | voice pipeline semantics | `eliza.voice` observes and coordinates; it does not replace talk mode. |
| connector plugins | connector | Discord, Google, Farcaster, Matrix, iMessage, and similar connectors stay plugins. |
| provider plugins | model/provider | OpenAI, OpenRouter, Ollama, LM Studio, MLX, and similar providers stay plugins. |
| app plugins | app semantics | Documents, training, task/workflow, browser-style app bundles stay app plugins. |

## Future eliza.computer Candidates

These are not Phase 19 implementation targets. They need overlap review before a new Satellite exists.

| Plugin | Capability | Decision |
| --- | --- | --- |
| `plugin-computeruse` | screen, input, windows, clipboard | Semantic actions stay plugin-owned; host implementation may route to future `eliza.computer`. |
| `plugin-browser` | browser/window host implementation | Browser bridge semantics stay plugin-owned; desktop implementation overlap needs review. |
| `plugin-native-screencapture` | screen capture/recording | Capture action semantics may stay as plugin facade. |
| `plugin-native-desktop` | desktop/window/system host access | Needs owner decision before collapse. |

## Needs Owner Decision

- Whether `eliza.computer` is justified after comparing `plugin-computeruse`, `plugin-browser`, `plugin-native-screencapture`, `plugin-native-camera`, `plugin-native-canvas`, and `plugin-native-desktop`.
- Whether `plugin-native-system` has semantic actions worth preserving before command execution collapses into `eliza.pty`.
- Whether `plugin-codex-cli` should keep local auth-file implementation in server mode while routing desktop mode through `eliza.fs`.

## Do-Not-Collapse List

- Connector plugins as connector semantics.
- Provider plugins as provider semantics.
- App plugins as app/product semantics.
- `packages/app` production UI.
- `packages/core` runtime ownership.
- `packages/app-core/platforms/electrobun` shell ownership.
- `eliza.surface`, which remains dev/admin only.
- `plugin-local-inference` as the actual local model provider/runtime.
- `plugin-native-talkmode` as the semantic voice-mode participant.

## First Routing Implementation

The routed paths are:

```text
plugin-coding-tools FILE ls/read/write
  -> runtime.getService("capability-router")
  -> router.fs.list() / router.fs.readText() / router.fs.writeText()
  -> eliza.runtime fs.list / fs.readText / fs.writeText
  -> eliza.fs

plugin-coding-tools SHELL
  -> runtime.getService("capability-router")
  -> router.pty.runCommand()
  -> eliza.runtime pty.command.run
  -> eliza.pty

plugin-coding-tools WORKTREE
  -> runtime.getService("capability-router")
  -> router.git.commandRun()
  -> eliza.runtime git.command.run
  -> eliza.git
```

If no router is registered, or if the router returns `CAPABILITY_UNAVAILABLE`, the existing sandboxed local implementation remains active. If the router is present and fails for any other reason, the action reports an `io_error` and does not bypass the failure through the local path.

## Non-Desktop Behavior

The shared fallback router returns structured `CAPABILITY_UNAVAILABLE` errors. Plugins with safe existing implementations may continue using those implementations when no router is registered. Plugins without a safe non-desktop implementation should return structured unavailable results instead of trying to reach Electrobun internals.

## Remaining Conflicts

- `plugin-coding-tools` still has direct local edit/search paths that need per-operation Satellite parity before routing.
- `plugin-browser` and `plugin-computeruse` overlap with possible future `eliza.computer` scope.
- `plugin-local-inference` must keep provider ownership while `eliza.local-model` controls desktop status/routing.
- `plugin-native-system` needs owner review before any implementation collapse.

## plugin-coding-tools FS Parity Decision

Do not route the remaining edit/search paths through `eliza.fs` as a batch. Route them only after explicit per-method parity is in place.

| Path | Current plugin behavior | Current `eliza.fs` parity | Decision |
| --- | --- | --- | --- |
| `FILE action=ls` | Session cwd fallback, absolute path validation, ignore globs, directory-first ordering, file/dir/symlink display, 1000-entry cap. | `fs.list` has root guard, hidden/generated exclusions, limits, typed stats, ignore patterns, and truncation metadata. `plugin-coding-tools` still owns cwd fallback, sandbox validation, and output formatting. | Routed through `capability-router.fs.list()` with local fallback when the router is absent or explicitly unavailable. |
| `FILE action=grep` | Ripgrep-backed regex search with output modes, glob/type filters, context flags, case-insensitive and multiline options, head limit, VCS excludes. | `fs.search` is literal case-insensitive substring search with path/root/limit/includeHidden only. | Do not route yet. Add a first-class search method with regex mode, literal mode, case sensitivity, multiline support, include/exclude glob filters, type filters, VCS/generated exclusion policy, context-before/context-after, head limit, deterministic ordering, structured file/line/column match records, truncation metadata, and explicit unsupported-option errors. |
| `FILE action=glob` | File globbing with VCS/generated excludes, recent-file ordering by mtime, 100-result cap. | No direct glob/list-recursive method with pattern semantics. | Do not route yet. Add a first-class glob/find method with cwd/root policy, one or more patterns, hidden/generated/VCS exclusion policy, file/dir/symlink filters, max-results, deterministic recent-file ordering where requested, typed file metadata, truncation metadata, and explicit unsupported-option errors. |
| `FILE action=edit` | Must-read-first/stale-read gate, exact substring replacement, optional replace-all, ambiguity protection, secret detection, line reporting. | `fs.writeText` overwrites full text only and has no compare-and-swap, old-string match, patch, secret gate, or read-state contract. | Do not route through generic write. Add a first-class edit/patch method with read-state or expected-digest protection, exact old-string replacement, replace-all behavior, ambiguity detection, first-changed-line metadata, secret-pattern rejection, atomic write behavior, and structured patch errors. |

Safe routing order:

1. `grep` and `glob`, only after search/glob semantics are explicit rather than approximated.
2. `edit`, only after the Satellite has a first-class edit/patch operation with stale-read or expected-content protection.

The review boundary stays small: each method should land as its own commit with focused tests.
