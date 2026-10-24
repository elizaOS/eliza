import { expect, mock, test } from "bun:test";

/**
 * A failed Android scan must reach the planner as an explicit error, the same
 * way the phone call-log provider reports a failed native read. Returning no
 * text makes a denied permission or a radio that is off look like "there are
 * no networks nearby".
 */
test("wifiNetworks reports a failed scan instead of an empty list", async () => {
  mock.module("@elizaos/plugin-native-wifi/bridge", () => ({
    WiFi: {
      listAvailableNetworks: async () => {
        throw new Error("android.permission.ACCESS_FINE_LOCATION denied");
      },
    },
  }));
  const { wifiNetworksProvider } = await import("./networks");

  const reported: unknown[] = [];
  if (!wifiNetworksProvider.get) throw new Error("provider has no get()");
  const result = await wifiNetworksProvider.get(
    {
      reportError: (_source: string, error: unknown) => reported.push(error),
    } as never,
    {} as never,
    {} as never,
  );

  expect(result.text).toContain("ACCESS_FINE_LOCATION");
  expect(result.data?.count).toBe(0);
  expect(reported).toHaveLength(1);
});
