/**
 * ElizaOS Signal Plugin — Native Presage-based Signal integration.
 *
 * Uses QR-authenticated device linking (created via the pairing service)
 * to send and receive Signal messages through the elizaOS runtime.
 *
 * Loaded as `@elizaos/plugin-signal` via CHANNEL_PLUGIN_MAP when
 * `config.connectors.signal` is present.
 *
 * ## Architecture
 *
 * This plugin uses `@elizaos/signal-native`, a standalone Node.js Signal
 * client built on Presage (Rust) + napi-rs bindings — the "baileys for
 * Signal". No Docker, no Java, no signal-cli required.
 *
 * ## License
 *
 * Plugin code is MIT. The underlying `@elizaos/signal-native` library is
 * AGPL-3.0 (inherits from Presage). This plugin lazily imports it via
 * public API, maintaining license isolation.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { sendSignalMessage } from "./actions";
import { SignalNativeService } from "./service";

export const signalPlugin: Plugin = {
  name: "signal",
  description: "Signal messaging via native Presage bindings (device linking)",

  services: [SignalNativeService as any],

  actions: [sendSignalMessage],

  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    runtime.logger.info("[signal] Plugin initialized");
  },
};

export default signalPlugin;
