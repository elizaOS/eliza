# ElizaLaunch Runtime Remote

ElizaLaunch is the desktop launcher direction for the existing elizaOS/Milady Electrobun app. It keeps the Bun, TypeScript, Electrobun, and elizaOS runtime stack intact while making desktop capabilities modular.

Eliza Orbit is the runtime environment that coordinates Remotes. Remotes are separately installable desktop capabilities with stable IDs.

`eliza.runtime` is the Runtime Remote. In this first-party Electrobun location it adapts to the existing desktop `AgentManager` for production runtime lifecycle calls, while keeping the standalone subprocess manager for isolated smoke tests. Phase 2 added a local API bridge so the Remote can discover the existing runtime routes and call supported lifecycle, status, agent, conversation, plugin, memory, and config endpoints. Phase 3 added a streaming chat bridge that normalizes the current local SSE stream into stable worker events. Phase 5 added brokered filesystem capability methods that forward to `eliza.fs`. Phase 6 added brokered terminal methods that forward to `eliza.pty`. Phase 7 adds brokered Git methods that forward to `eliza.git`.

This package does not migrate the production dashboard, add Swift, add MLX, add Model Remotes, or rewrite elizaOS core.

## Remote IDs

- `eliza.runtime` - Runtime Remote
- `eliza.surface` - Surface Remote
- `eliza.fs` - File Remote
- `eliza.pty` - Terminal Remote
- `eliza.git` - Git Remote
- `eliza.local-model` - future Model Remote

## Runtime Supervision

When installed as a bundled first-party Remote inside `packages/app-core/platforms/electrobun`, `runtime.start`, `runtime.stop`, `runtime.restart`, `runtime.status`, `runtime.health`, and `runtime.logs.tail` call the host `AgentManager` through host requests. Production mode does not start a second elizaOS runtime process.

`ElizaRuntimeManager` remains available for standalone development and smoke tests. It starts the runtime command, captures stdout and stderr line by line, tracks process state, probes local health endpoints, and stops or restarts the child process on request.

Default runtime settings:

- `cwd`: `MILADY_REPO_DIR`, then `ELIZA_REPO_DIR`, then the detected repo root
- `command`: `ELIZA_RUNTIME_COMMAND`, otherwise `bun run dev`
- `apiBase`: `ELIZA_RUNTIME_API_BASE`, otherwise `http://127.0.0.1:31337`

Health probing tries these paths in order:

- `/api/dev/stack`
- `/api/status`
- `/api/health`

Probe failures return structured failures and do not make `runtime.start` fail.

## Runtime API Bridge

`ElizaRuntimeApiClient` uses the Runtime Remote `apiBase` and probes the existing local API. Route discovery does not assume every route exists. GET routes are probed with GET. POST routes are listed but not marked available from generic OPTIONS preflight alone, because the current local server answers CORS preflight before route matching.

Discovery reports each candidate as:

```ts
{
  name: string;
  method: "GET" | "POST" | "OPTIONS";
  path: string;
  available: boolean;
  status?: number;
  error?: string;
}
```

Missing routes return structured `ROUTE_UNAVAILABLE` errors. Failed HTTP requests return `REQUEST_FAILED`. Bad response shapes return `DECODE_FAILED`. Missing API base returns `API_BASE_MISSING`.

Streaming discovery also reports:

```ts
{
  name: string;
  method: "GET" | "POST";
  path: string;
  available: boolean;
  status?: number;
  error?: string;
}
```

## Streaming Bridge

The current dashboard uses the local conversation SSE route:

```txt
POST /api/conversations/:conversationId/messages/stream
```

The route is implemented in `packages/agent/src/api/conversation-routes.ts` and consumed by `packages/ui/src/api/client-chat.ts` through `sendConversationMessageStream`. It emits SSE `data:` frames with `type: "token"`, `type: "done"`, and `type: "error"`. Token frames with non-empty `text` are treated as deltas. Full-text-only updates are treated as snapshots.

The Runtime Remote stream bridge starts that route, parses SSE safely, and emits worker events. It also understands the existing OpenAI-compatible `/v1/chat/completions` and Anthropic-compatible `/v1/messages` SSE shapes as fallback parsers. It does not make non-streaming `agent.message` streaming.

## File Capability Broker

Runtime exposes `fs.*` methods as a broker for `eliza.fs`. It does not perform filesystem access itself. Calls are forwarded through the existing worker-to-worker module invoke boundary.

If `eliza.fs` is unavailable, Runtime returns `CAPABILITY_UNAVAILABLE` with the message `File Remote eliza.fs is not available`.

## Terminal Capability Broker

Runtime exposes `pty.*` methods as a broker for `eliza.pty`. It does not create terminal sessions itself. Calls are forwarded through the existing worker-to-worker module invoke boundary.

If `eliza.pty` is unavailable, Runtime returns `CAPABILITY_UNAVAILABLE` with the message `Terminal Remote eliza.pty is not available`.

## Git Capability Broker

Runtime exposes `git.*` methods as a broker for `eliza.git`. It does not run Git commands itself. Calls are forwarded through the existing worker-to-worker module invoke boundary.

If `eliza.git` is unavailable, Runtime returns `CAPABILITY_UNAVAILABLE` with the message `Git Remote eliza.git is not available`.

## Methods

Runtime:

- `runtime.start`
- `runtime.stop`
- `runtime.restart`
- `runtime.status`
- `runtime.health`
- `runtime.logs.tail`

Runtime API:

- `api.discover`
- `api.status`

Agents:

- `agent.list`
- `agent.get`
- `agent.message`

Conversations:

- `conversation.list`
- `conversation.get`

Plugins:

- `plugin.list`

Memory:

- `memory.search`

Config:

- `config.get`

Streaming:

- `agent.message.stream`
- `agent.message.stream.cancel`
- `agent.message.stream.status`

Filesystem:

- `fs.status`
- `fs.roots`
- `fs.stat`
- `fs.list`
- `fs.readText`
- `fs.search`
- `fs.writeText`

Terminal:

- `pty.status`
- `pty.session.create`
- `pty.session.list`
- `pty.session.get`
- `pty.session.write`
- `pty.session.resize`
- `pty.session.kill`
- `pty.session.output.tail`
- `pty.session.output.clear`
- `pty.command.run`

Git:

- `git.status`
- `git.repo.info`
- `git.branches`
- `git.remotes`
- `git.log`
- `git.diff`
- `git.show`
- `git.add`
- `git.restore`
- `git.checkout`
- `git.branch.create`
- `git.branch.delete`
- `git.commit`
- `git.fetch`
- `git.pull`
- `git.push`
- `git.operation.list`
- `git.operation.get`
- `git.command.run`

## Events

- `runtime.statusChanged`
- `runtime.log`
- `runtime.error`
- `runtime.started`
- `runtime.stopped`
- `agent.message.stream.started`
- `agent.message.stream.delta`
- `agent.message.stream.snapshot`
- `agent.message.stream.action`
- `agent.message.stream.error`
- `agent.message.stream.done`
- `agent.message.stream.cancelled`

## Run

Build:

```sh
bun run --cwd elizalaunch/remotes/runtime build
```

Phase 1 smoke:

```sh
bun run --cwd elizalaunch/remotes/runtime smoke
bun run --cwd elizalaunch/remotes/runtime smoke:phase1
```

Phase 2 smoke:

```sh
bun run --cwd elizalaunch/remotes/runtime smoke:phase2
```

Phase 3 smoke:

```sh
bun run --cwd elizalaunch/remotes/runtime smoke:phase3
```

Light process-supervision smoke:

```sh
ELIZA_RUNTIME_COMMAND='bun -e "process.stdout.write(\"runtime smoke\\n\"); setInterval(() => {}, 1000)"' \
ELIZA_RUNTIME_API_BASE='http://127.0.0.1:9' \
bun run --cwd elizalaunch/remotes/runtime smoke
```

Optional real-message smoke:

```sh
ELIZA_PHASE2_SEND_TEST_MESSAGE=1 \
bun run --cwd elizalaunch/remotes/runtime smoke:phase2
```

Optional stop-after smoke:

```sh
ELIZA_PHASE2_STOP_AFTER=1 \
bun run --cwd elizalaunch/remotes/runtime smoke:phase2
```

Optional real stream smoke:

```sh
ELIZA_PHASE3_SEND_STREAM_MESSAGE=1 \
bun run --cwd elizalaunch/remotes/runtime smoke:phase3
```

Optional stream cancellation smoke:

```sh
ELIZA_PHASE3_SEND_STREAM_MESSAGE=1 \
ELIZA_PHASE3_CANCEL_AFTER_MS=1000 \
bun run --cwd elizalaunch/remotes/runtime smoke:phase3
```

Optional Phase 3 stop-after smoke:

```sh
ELIZA_PHASE3_STOP_AFTER=1 \
bun run --cwd elizalaunch/remotes/runtime smoke:phase3
```

## Dev UI

The dev page is in `src/web/index.html`. It exposes Start, Stop, Restart, Runtime Status, Runtime Health, Logs, API discovery, API status, agent list/detail/message, conversation list/detail, plugin list, memory search, config retrieval, streaming message, stream cancellation, and stream status. It is a Phase 3 validation panel, not the production dashboard.

## Environment

- `MILADY_REPO_DIR`: preferred runtime working directory
- `ELIZA_REPO_DIR`: fallback runtime working directory
- `ELIZA_RUNTIME_COMMAND`: runtime command string for development
- `ELIZA_RUNTIME_API_BASE`: local API base for health probes and API bridge calls
- `ELIZA_RUNTIME_API_TOKEN`: optional bearer token for local API requests
- `MILADY_API_TOKEN`: optional bearer token fallback
- `ELIZA_PHASE2_SEND_TEST_MESSAGE`: set to `1` to send a real message in `smoke:phase2`
- `ELIZA_PHASE2_STOP_AFTER`: set to `1` to stop the supervised runtime after `smoke:phase2`
- `ELIZA_PHASE3_SEND_STREAM_MESSAGE`: set to `1` to send a real streaming message in `smoke:phase3`
- `ELIZA_PHASE3_CANCEL_AFTER_MS`: cancel an enabled Phase 3 stream after this many milliseconds
- `ELIZA_PHASE3_STOP_AFTER`: set to `1` to stop the supervised runtime after `smoke:phase3`
- `ELIZA_FS_ROOTS`: consumed by `eliza.fs`, not Runtime, to configure allowed filesystem roots
- `ELIZA_FS_ENABLE_WRITES`: consumed by `eliza.fs`, not Runtime, to enable gated writes
- `ELIZA_MODEL_HF_REPO`: consumed by `eliza.local-model`, default `elizaos/eliza-1`
- `ELIZA_MODEL_HF_DISABLE_NETWORK`: consumed by `eliza.local-model` to force local Eliza-1 snapshot metadata

## Local Module Manager

The existing desktop module manager can install from a local directory through the typed desktop bridge. Use this source directory:

```sh
packages/app-core/platforms/electrobun/remotes/runtime
```

The required package-side fields are present:

- `plugin.json`
- `id: "eliza.runtime"`
- `mode: "background"`
- `worker.relativePath: "src/bun/worker.ts"`
- `view.relativePath: "src/web/index.html"`
- nested `host` and `bun` permission maps accepted by the local validator

After install, start `eliza.runtime` from the existing module manager. If the current app UI still labels this surface with upstream terminology, that is host UI copy outside this package; this Remote keeps Eliza-facing package naming to ElizaLaunch, Eliza Orbit, and Remotes.

## Current Upstream Packaging Notes

The existing Electrobun module system in this repo still uses upstream packaging names such as `plugin.json`, `build.carrot`, and `carrotOnly`. Those names are kept only where the upstream API requires them.

The current host manifest shape supports `host.storage`, `bun.read`, `bun.write`, `bun.env`, `bun.run`, and `bun.worker` through nested `host` and `bun` permission maps. The requested flat permission keys are not the shape used by the current `@elizaos/plugin-remote-manifest` types, so the Runtime Remote uses the existing nested format.

The current host can downgrade `isolation: "isolated-process"` to a shared worker. The bundled first-party Runtime Remote delegates production process ownership to the existing Electrobun `AgentManager`; only standalone smoke tests use the subprocess manager directly.

## Known Limitations

- No production dashboard migration is implemented.
- No elizaOS core rewrite is implemented.
- The dev page is only a Phase 3 validation surface.
- POST route discovery does not treat generic OPTIONS preflight as route availability. The actual request path still handles unsupported routes with structured errors.
- Stream discovery identifies templated routes from source but does not send probe messages during discovery.
- The full default command may start the current desktop development stack; use `ELIZA_RUNTIME_COMMAND` for targeted smoke runs.
- Filesystem methods require `eliza.fs` to be installed and running.
- PTY methods require `eliza.pty` to be installed and running.
- Git methods require `eliza.git` to be installed and running.
- Model methods require `eliza.local-model` to be installed and running.

## Brokered Model Methods

Runtime brokers these methods to the Model Remote and passes its current `apiBase` when the caller did not provide one:

- `model.status`
- `model.hub`
- `model.catalog`
- `model.catalog.eliza1`
- `model.eliza1.tiers`
- `model.eliza1.voice`
- `model.hf.metadata`
- `model.providers`
- `model.hardware`
- `model.installed`
- `model.download.start`
- `model.download.cancel`
- `model.downloads`
- `model.active`
- `model.activate`
- `model.unload`
- `model.assignments`
- `model.assignment.set`
- `model.routing`
- `model.routing.set`
- `model.routing.useLocal`
- `model.routing.useCloud`
- `model.generate`
- `model.embedding`
- `model.capabilities`

Runtime does not implement local inference or download behavior directly. `eliza.local-model` owns Eliza-1 catalog/status/download/routing logic.
