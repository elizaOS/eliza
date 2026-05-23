import { describe, expect, it } from "vitest";
import { CHANNEL_TO_RPC_METHOD } from "./rpc-schema";

describe("dynamic view RPC schema", () => {
  it("maps desktop window channels to typed RPC methods", () => {
    expect(CHANNEL_TO_RPC_METHOD).toMatchObject({
      "desktop:openSettingsWindow": "desktopOpenSettingsWindow",
      "desktop:openSurfaceWindow": "desktopOpenSurfaceWindow",
      "desktop:openAppWindow": "desktopOpenAppWindow",
      "desktop:setManagedWindowAlwaysOnTop":
        "desktopSetManagedWindowAlwaysOnTop",
    });
  });

  it("maps every legacy dynamic-view channel to its typed RPC method", () => {
    expect(CHANNEL_TO_RPC_METHOD).toMatchObject({
      "dynamic-view:register": "dynamicViewRegister",
      "dynamic-view:unregister": "dynamicViewUnregister",
      "dynamic-view:list": "dynamicViewList",
      "dynamic-view:open": "dynamicViewOpen",
      "dynamic-view:close": "dynamicViewClose",
      "dynamic-view:push": "dynamicViewPush",
      "dynamic-view:sessions": "dynamicViewSessions",
    });
  });

  it("keeps dynamic-view channel names unique and namespaced", () => {
    const dynamicViewEntries = Object.entries(CHANNEL_TO_RPC_METHOD).filter(
      ([channel]) => channel.startsWith("dynamic-view:"),
    );

    expect(dynamicViewEntries).toHaveLength(7);
    expect(new Set(dynamicViewEntries.map(([, method]) => method)).size).toBe(
      dynamicViewEntries.length,
    );
  });
});
