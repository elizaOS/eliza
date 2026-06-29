/**
 * Worker entrypoint. Bootstrap simply hands the Plugin object to
 * @elizaos/plugin-worker-runtime and lets the announce/dispatch loop
 * take over. The Service inside `plugin.services[0]` is started lazily
 * on first method invocation via the service trampoline.
 */

import { bootstrap } from "../worker-runtime/index.js";
import { plugin } from "./plugin.js";

await bootstrap(plugin);
