# Capability Collapse Matrix

This matrix tightens the convergence audit by separating semantic plugin interfaces from desktop implementation paths. The rule is: collapse implementation, not meaning.

## Executive Summary

Plugins remain the elizaOS runtime extension layer. They own agent-facing actions, providers, services, routes, events, model handlers, connector semantics, and app/product semantics.

Satellites own desktop/system implementation behind the Electrobun host boundary. A plugin should use a shared capability router when it needs local filesystem, terminal, local Git, or local model host coordination in the desktop shell. The router targets `eliza.runtime`, and `eliza.runtime` brokers to the concrete Satellite.

This phase starts with one low-risk implementation route: `plugin-coding-tools` FILE read prefers the shared capability router when a `capability-router` service is registered. If the router is absent or explicitly unavailable, the existing sandboxed local implementation remains the fallback.

## Collapse Immediately Candidates

| Plugin | Capability | Route | Mode | Risk |
| --- | --- | --- | --- | --- |
| `plugin-coding-tools` | filesystem read | `eliza.fs` | facade-over-satellite | low |

The first implementation path is intentionally narrow. The FILE action still owns the agent-facing semantics, path policy, output formatting, and per-conversation read state. The file-content read can come from `eliza.fs` through the capability router.

## Facade-Over-Satellite Candidates

| Plugin | Capability | Route | Notes |
| --- | --- | --- | --- |
| `plugin-coding-tools` | terminal | `eliza.pty` | SHELL remains the action; command execution should route through PTY later. |
| `plugin-coding-tools` | local Git | `eliza.git` | WORKTREE/local Git helpers should route through Git later. |
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

The first routed path is:

```text
plugin-coding-tools FILE read
  -> runtime.getService("capability-router")
  -> router.fs.readText()
  -> eliza.runtime fs.readText
  -> eliza.fs
```

If no router is registered, or if the router returns `CAPABILITY_UNAVAILABLE`, the existing sandboxed local implementation remains active. If the router is present and fails for any other reason, the action reports an `io_error` and does not bypass the failure through the local path.

## Non-Desktop Behavior

The shared fallback router returns structured `CAPABILITY_UNAVAILABLE` errors. Plugins with safe existing implementations may continue using those implementations when no router is registered. Plugins without a safe non-desktop implementation should return structured unavailable results instead of trying to reach Electrobun internals.

## Remaining Conflicts

- `plugin-coding-tools` still has direct local write/edit/search/shell/Git paths.
- `plugin-browser` and `plugin-computeruse` overlap with possible future `eliza.computer` scope.
- `plugin-local-inference` must keep provider ownership while `eliza.local-model` controls desktop status/routing.
- `plugin-native-system` needs owner review before any implementation collapse.
