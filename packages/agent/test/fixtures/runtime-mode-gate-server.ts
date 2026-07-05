/**
 * Child fixture for the runtime-mode gate e2e: boots the REAL bare agent API
 * server (the same `startApiServer` that root `bun run start` binds, no
 * app-core wrapper) on an ephemeral loopback port and prints the bound port
 * for the parent test to probe. Config comes from the `ELIZA_STATE_DIR` the
 * parent points at. Runs until killed by the parent.
 */
import { startApiServer } from "../../src/api/server.ts";

const api = await startApiServer({ port: 0, skipDeferredStartupWork: true });
console.log(`GATE_E2E_PORT=${api.port}`);
