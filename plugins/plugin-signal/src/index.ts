/**
 * Explicit unsupported boundary for Signal until an in-process transport can
 * be distributed without an external daemon or an incompatible dependency.
 */
import { ElizaError, type Plugin } from "@elizaos/core";

export const SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE = "SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE";

export function signalUnsupportedError(): ElizaError {
  return new ElizaError(
    "Signal is unsupported: no bundled in-process Signal transport is available.",
    {
      code: SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE,
      context: {
        requiredTransport: "in-process",
        externalProcessesAllowed: false,
      },
      severity: "fatal",
    }
  );
}

const signalPlugin: Plugin = {
  name: "signal-unsupported",
  description:
    "Signal is unavailable until elizaOS can ship an in-process protocol implementation.",
  actions: [],
  providers: [],
  services: [],
  routes: [],
  init: async () => {
    throw signalUnsupportedError();
  },
};

export default signalPlugin;
