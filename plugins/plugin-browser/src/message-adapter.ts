import {
  BaseMessageAdapter,
  type IAgentRuntime,
  type MessageAdapterCapabilities,
  type MessageSource,
} from "@elizaos/core";

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
