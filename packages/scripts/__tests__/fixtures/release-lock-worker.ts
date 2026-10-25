/**
 * Observes the bare remote's release tag and creates the competing state lock
 * before the publisher can record its post-push transition.
 */

import { existsSync, writeFileSync } from "node:fs";
import { workerData } from "node:worker_threads";

const { lockPath, ready: readyBuffer, refPath } = workerData;
const ready = new Int32Array(readyBuffer);
Atomics.store(ready, 0, 1);
Atomics.notify(ready, 0);

while (!existsSync(refPath)) Atomics.wait(ready, 0, 1, 1);
writeFileSync(lockPath, "post-push interruption\n");
