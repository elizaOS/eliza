/**
 * PTY service plugin for elizaOS web terminal sessions.
 * It registers the `PTY_SERVICE` bridge and authenticated spawn/list/stop routes that connect the existing xterm UI and WebSocket path to real interactive CLI processes.
 */

import type { Plugin } from "@elizaos/core";
import { ptyRoutes } from "./routes/pty-routes";
import { PtyService } from "./services/pty-service";

export const ptyPlugin: Plugin = {
  name: "pty",
  description:
    "Interactive PTY terminal service — real CLI (eliza-code on cerebras) in the web terminal",
  services: [PtyService],
  routes: ptyRoutes,
  async dispose(runtime) {
    await runtime.getService<PtyService>(PtyService.serviceType)?.stop();
  },
};

export default ptyPlugin;

export {
  buildElizaCodeCerebrasSpec,
  ELIZA_CLOUD_DEFAULT_BASE_URL,
  ELIZA_CLOUD_FAST_MODEL,
  ELIZA_CLOUD_SMART_MODEL,
  type ElizaCodeCerebrasOptions,
  resolveElizaCodeBin,
} from "./lib/eliza-code-spec";
export {
  buildClaudeCliSpec,
  buildCodexCliSpec,
  type ClaudeCliSpecOptions,
  type CodexCliSpecOptions,
  type PtyVendorCliKind,
  resolveClaudeCliBin,
  resolveCodexCliBin,
} from "./lib/vendor-cli-spec";
export { bunTruePtySpawn, isBunRuntime } from "./services/bun-pty-spawn";
export type {
  ConsoleBridge,
  SessionExitEvent,
  SessionOutputEvent,
} from "./services/pty-contract";
export { PtyService } from "./services/pty-service";
export {
  defaultSpawnResolver,
  PtyConsoleBridge,
  PtySessionStore,
  type PtySpawnResolver,
} from "./services/pty-session-store";
export type {
  PtyHandle,
  PtySessionInfo,
  PtySpawn,
  PtySpawnSpec,
} from "./services/pty-types";
