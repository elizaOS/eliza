# Eliza Surface Remote

ElizaLaunch is the desktop launcher layer around the existing Bun/TypeScript elizaOS runtime. Eliza Orbit is the runtime environment that coordinates Remotes. Remotes are focused modules that expose one capability through the module boundary.

`eliza.surface` is the first Surface Remote. It provides a control and chat UI backed by `eliza.runtime`.

## Phase 4 Scope

The Surface Remote consumes Runtime Remote methods and events instead of calling local `/api/...` routes directly. It is a dev/control surface for proving the Eliza Orbit boundary and does not replace the production dashboard yet.

It can call:

- `runtime.start`
- `runtime.stop`
- `runtime.restart`
- `runtime.status`
- `runtime.health`
- `runtime.logs.tail`
- `api.discover`
- `api.status`
- `agent.list`
- `agent.get`
- `agent.message`
- `agent.message.stream`
- `agent.message.stream.cancel`
- `agent.message.stream.status`
- `conversation.list`
- `conversation.get`
- `plugin.list`
- `memory.search`
- `config.get`
- `fs.status`
- `fs.roots`
- `fs.stat`
- `fs.list`
- `fs.readText`
- `fs.search`
- `fs.writeText`
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

It consumes:

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

## Smoke

```sh
bun run --cwd elizalaunch/remotes/surface smoke
bun run --cwd elizalaunch/remotes/surface smoke:phase4
```

The smoke test uses a mock module bridge. It verifies that runtime status, API discovery, agent listing, stream start, token deltas, snapshots, action events, and done events update Surface state correctly without requiring a real LLM response.

It also mocks filesystem calls through `eliza.runtime` and verifies roots, listing, text reads, and search results update Surface state.

It also mocks terminal calls through `eliza.runtime` and verifies status, session creation, output tailing, input writes, and kill status update Surface state.

It also mocks Git calls through `eliza.runtime` and verifies repo info, status, branches, log, and operation history update Surface state.

It also mocks model calls through `eliza.runtime` and verifies Eliza-1 catalog, tier, voice, active model, and download state update Surface state.

## Module Manager Compatibility

The current upstream module system still uses packaging names such as `plugin.json`, `build.remote plugin`, and `remote pluginOnly`. Those names remain only at the packaging boundary.

The Surface manifest uses:

- ID: `eliza.surface`
- Dependency: `eliza.runtime`
- Mode: `window`
- Permission: `host:manage-remote-plugins`

`host:manage-remote-plugins` is required by the existing module host for cross-Remote calls through the upstream `invoke-remote-plugin` host request. No filesystem, shell, Git, model-download, or child-process permission is requested by Surface.

The Surface worker implements that module call path. The current host does not expose a completed public view-to-Remote-worker RPC for window-mode Remotes, so the browser UI uses `RuntimeRemoteClient` and can run against a host-provided bridge when available or the smoke-test mock bridge in Phase 4.

## Runtime Dependency

Start or install `eliza.runtime` before using this Surface Remote. The UI calls the Runtime Remote through `RuntimeRemoteClient`; it does not call elizaOS local HTTP routes directly.

## File Panel

The File panel calls Runtime Remote `fs.*` methods only:

```text
eliza.surface -> eliza.runtime -> eliza.fs
```

It can load roots, list a scoped directory, read text, search text, and send a gated write request. The write button is disabled until the user enables it in the panel, and `eliza.fs` still rejects writes unless `ELIZA_FS_ENABLE_WRITES=1`.

## Terminal Panel

The Terminal panel calls Runtime Remote `pty.*` methods only:

```text
eliza.surface -> eliza.runtime -> eliza.pty
```

It can create a trusted local terminal session, list sessions, tail output, send input, resize, clear output, and kill the active session. The panel does not call `eliza.pty` directly and does not call local process APIs.

## Git Panel

The Git panel calls Runtime Remote `git.*` methods only:

```text
eliza.surface -> eliza.runtime -> eliza.git
```

It can inspect repo info, status, branches, remotes, log, diff, and show output. It can also invoke add, restore, checkout, branch create/delete, commit, fetch, pull, and push through the Runtime broker. Operation output is shown through the operation list/detail area. The panel does not call `eliza.git` directly and does not call local Git or process APIs.

## Model Panel

The Model panel calls Runtime Remote `model.*` methods only:

```text
eliza.surface -> eliza.runtime -> eliza.local-model
```

It can show the Eliza-1 hub, catalog, HF metadata, tiers, voice components, hardware, providers, installed models, downloads, active model, assignments, and routing. It can request activation, unload, download, cancel download, local/cloud routing, direct generation, and embedding through the Runtime broker. The panel does not call `eliza.local-model`, Hugging Face, local inference routes, or local process APIs directly.

## Event Subscription Status

The existing host supports worker-to-worker request routing and targeted event emission, but Runtime Remote events are not automatically broadcast to `eliza.surface` windows today. The Surface client subscribes to runtime events when the bridge provides them and also polls `runtime.status` and `runtime.logs.tail` as a fallback.

Phase 5 or a later host pass should add a small event-forwarding hook if true cross-Remote push events are required.

## Known Limitations

- This is a Phase 4 control UI, not the production dashboard migration.
- Cross-Remote event push depends on host support or a Runtime Remote forwarding hook.
- File panel requests require `eliza.runtime` and `eliza.fs` to be running.
- Terminal panel requests require `eliza.runtime` and `eliza.pty` to be running.
- Git panel requests require `eliza.runtime` and `eliza.git` to be running.
- Model panel requests require `eliza.runtime` and `eliza.local-model` to be running.
- The UI is intentionally vanilla TypeScript to keep the Remote boundary clear.
- No Swift or MLX work is included.
