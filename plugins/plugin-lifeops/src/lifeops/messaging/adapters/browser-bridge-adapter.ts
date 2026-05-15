import type {
  IAgentRuntime,
  MessageAdapterCapabilities,
  MessageSource,
} from "@elizaos/core";
import { BaseMessageAdapter } from "@elizaos/core";

export class BrowserBridgeAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "browser_bridge";

  isAvailable(_runtime: IAgentRuntime): boolean {
    return false;
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
