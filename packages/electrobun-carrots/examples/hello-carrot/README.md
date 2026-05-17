# hello-carrot

Reference carrot for validating the Electrobun carrot host end-to-end. The worker reads `globalThis.__bunnyCarrotBootstrap` (injected by the host's `writeCarrotWorkerBootstrap`), writes a state file, appends a boot line to its log file, and posts one `action:log` message back to the host.

## What it proves

- The bootstrap injection is reachable inside the worker.
- `context.statePath` and `context.logsPath` resolve to real paths under the carrot's store directory.
- The host's `handleWorkerMessage` action loop picks up `action:log` payloads.

## Install from source

```ts
import { getCarrotManager } from "@elizaos/app-core/platforms/electrobun/native/carrots";
import { resolve } from "node:path";

const manager = getCarrotManager();
manager.installFromDirectory({
  sourceDir: resolve("packages/electrobun-carrots/examples/hello-carrot"),
  devMode: true,
});
manager.startWorker("hello-carrot");
```

After install, the store layout under `<MILADY_CARROT_STORE_DIR>/hello-carrot/` looks like:

```
current/
  carrot.json
  worker.mjs
  view/index.html
  .bunny/
    carrot-bun-entrypoint.mjs   ← host-generated bootstrap wrapper
data/
  state.json                     ← written by the worker on boot
  logs.txt                       ← appended on every action:log
```

## Inspect the result

```sh
cat ~/.eliza/carrots/hello-carrot/data/state.json
tail ~/.eliza/carrots/hello-carrot/data/logs.txt
```
