/** Profile settings preserve runtime authority and only admit the connected profile. */
import type { IAgentRuntime } from "@elizaos/core";
import type { RouteHandlerContext } from "@elizaos/core/api/http-plugin";
import { expect, it } from "vitest";
import { nativeDeviceBrowserProfileRoutes } from "./native-device";

const profile = { targetId: "chromium-device", profileId: "owner-profile" };
function runtime() {
  const cache = new Map<string, unknown>();
  return {
    cache,
    getService: () => ({ getNativeDeviceStatus: () => profile }),
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
  };
}
async function request(
  method: string,
  authority: ReturnType<typeof runtime>,
  body?: unknown,
) {
  const handler = nativeDeviceBrowserProfileRoutes.find(
    (route) => route.type === method,
  )?.routeHandler;
  if (!handler) throw new Error("Profile route missing");
  const context: RouteHandlerContext = {
    runtime: authority as unknown as IAgentRuntime,
    body,
    params: {},
    query: {},
    headers: {},
    method,
    path: "/api/browser-device/profile",
    inProcess: true,
  };
  return handler(context);
}
it("stores a profile only for the active runtime and persists an explicit disable", async () => {
  const first = runtime();
  const second = runtime();
  expect((await request("PUT", first, { selected: profile })).status).toBe(200);
  expect((await request("GET", first)).body).toEqual({
    connected: profile,
    selected: profile,
  });
  expect((await request("GET", second)).body).toEqual({
    connected: profile,
    selected: null,
  });
  await request("PUT", first, { selected: null });
  expect(first.cache.get("browser.search-profile")).toEqual({ disabled: true });
  expect(second.cache.size).toBe(0);
});
it("rejects another profile without persisting it and reports failed persistence", async () => {
  const authority = runtime();
  expect(
    (
      await request("PUT", authority, {
        selected: { ...profile, profileId: "other" },
      })
    ).status,
  ).toBe(409);
  expect(authority.cache.size).toBe(0);
  authority.setCache = async () => false;
  await expect(
    request("PUT", authority, { selected: profile }),
  ).rejects.toMatchObject({ code: "BROWSER_PROFILE_SAVE_FAILED" });
});
