# hello-remote-plugin

Reference remotePlugin for validating the Electrobun remotePlugin host end-to-end. The worker reads `globalThis.__bunnyRemotePluginBootstrap` (injected by the host's `writeRemotePluginWorkerBootstrap`), writes a state file, appends a boot line to its log file, and posts one `action:log` message back to the host.

## What it proves

- The bootstrap injection is reachable inside the worker.
- `context.statePath` and `context.logsPath` resolve to real paths under the remotePlugin's store directory.
- The host's `handleWorkerMessage` action loop picks up `action:log` payloads.

## Install from source

```ts
import { getRemotePluginHost } from "@elizaos/app-core/platforms/electrobun/native/remote-plugin-host";
import { resolve } from "node:path";

const manager = getRemotePluginHost();
manager.installFromDirectory({
  sourceDir: resolve("packages/electrobun-remotePlugins/examples/hello-remote-plugin"),
  devMode: true,
});
manager.startWorker("hello-remote-plugin");
```

After install, the store layout under `<MILADY_REMOTE_PLUGIN_STORE_DIR>/hello-remote-plugin/` looks like:

```
current/
  remotePlugin.json
  worker.mjs
  view/index.html
  .bunny/
    remotePlugin-bun-entrypoint.mjs   ← host-generated bootstrap wrapper
data/
  state.json                     ← written by the worker on boot
  logs.txt                       ← appended on every action:log
```

## Inspect the result

```sh
cat ~/.eliza/remotePlugins/hello-remote-plugin/data/state.json
tail ~/.eliza/remotePlugins/hello-remote-plugin/data/logs.txt
```
