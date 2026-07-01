import type { Plugin } from "@elizaos/core";
import { ptyRoutes } from "./routes/pty-routes";
import { PtyService } from "./services/pty-service";

/**
 * `@elizaos/plugin-pty` — registers `PTY_SERVICE`, the one piece the app's web
 * terminal needs to drive a real interactive CLI.
 *
 * The xterm UI, the WebSocket `pty-input`/`pty-output`/`pty-resize` handlers in
 * the agent server, and the interactive `eliza-code` CLI already exist. Without
 * a registered `PTY_SERVICE`, `getPtyConsoleBridge()` returns null and the
 * terminal is inert. This plugin supplies that service (a node-pty–backed
 * console bridge) plus routes to spawn/list/stop sessions — most importantly an
 * interactive `eliza-code` session pointed at Eliza Cloud/cerebras, giving a
 * real CLI with all slash commands on any device, with an agent we own (no TOS
 * exposure).
 *
 * Opt-in: add it to an agent's plugin list. Intended for the developer-gated
 * cockpit; disabled automatically on store builds.
 */
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

export { PtyService } from "./services/pty-service";
export {
  PtyConsoleBridge,
  PtySessionStore,
  defaultSpawnResolver,
  type PtySpawnResolver,
} from "./services/pty-session-store";
export { bunTruePtySpawn, isBunRuntime } from "./services/bun-pty-spawn";
export {
  buildElizaCodeCerebrasSpec,
  resolveElizaCodeBin,
  ELIZA_CLOUD_DEFAULT_BASE_URL,
  ELIZA_CLOUD_FAST_MODEL,
  ELIZA_CLOUD_SMART_MODEL,
  type ElizaCodeCerebrasOptions,
} from "./lib/eliza-code-spec";
export type {
  PtyHandle,
  PtySpawn,
  PtySpawnSpec,
  PtySessionInfo,
} from "./services/pty-types";
export type {
  ConsoleBridge,
  SessionOutputEvent,
  SessionExitEvent,
} from "./services/pty-contract";
