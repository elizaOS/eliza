/**
 * Registers Signal into the shared cross-connector triage service so MESSAGE
 * triage recognizes the `"signal"` source. `registerSignalTriageAdapter`
 * installs `SignalMessageAdapter`, whose availability tracks whether this
 * plugin's `signal` service is registered on the runtime.
 */
import {
  BaseMessageAdapter,
  getDefaultTriageService,
  type IAgentRuntime,
  type MessageAdapterCapabilities,
  type MessageSource,
} from "@elizaos/core";

/**
 * Signal triage adapter. Availability hinges on the signal service (provided by
 * this plugin) being registered. Registered into the shared TriageService so
 * cross-connector MESSAGE triage recognizes the "signal" source. Capability
 * flags default off until the underlying adapter wires them up.
 */
export class SignalMessageAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "signal";

  isAvailable(runtime: IAgentRuntime): boolean {
    return runtime.getService("signal") != null;
  }

  capabilities(): MessageAdapterCapabilities {
    return {
      list: false,
      search: false,
      manage: {},
      send: {},
      worlds: "single",
      channels: "implicit",
    };
  }
}

export function registerSignalTriageAdapter(): void {
  getDefaultTriageService().register(new SignalMessageAdapter());
}
