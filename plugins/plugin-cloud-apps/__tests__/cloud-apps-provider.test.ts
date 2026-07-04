/**
 * CLOUD_APPS provider tests: app inventory injected into planner context, plus the 60s cache and invalidation. The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { cloudAppsProvider } = await import("../src/providers/cloud-apps.ts");

const STATE = {} as never;

describe("CLOUD_APPS provider", () => {
  beforeEach(() => {
    resetSdk();
  });

  it("injects the app inventory when a key is present", async () => {
    setListApps(() =>
      Promise.resolve({
        success: true,
        apps: [
          makeApp({
            name: "Acme Bot",
            production_url: "https://acme.elizacloud.ai",
            deployment_status: "deployed",
          }),
          makeApp({ name: "Side Project", deployment_status: "draft" }),
        ],
      }),
    );

    const result = await cloudAppsProvider.get(
      keyedRuntime(),
      makeMessage("my apps"),
      STATE,
    );

    expect(result.text).toContain("2 Eliza Cloud apps");
    expect(result.text).toContain("Acme Bot");
    expect(result.text).toContain("https://acme.elizacloud.ai");
    expect(result.text).toContain("Side Project");
    expect(result.values?.cloudAppCount).toBe(2);
  });

  it("returns EMPTY when no Cloud API key is configured", async () => {
    let called = false;
    setListApps(() => {
      called = true;
      return Promise.resolve({ success: true, apps: [] });
    });

    const result = await cloudAppsProvider.get(
      unkeyedRuntime(),
      makeMessage("my apps"),
      STATE,
    );

    expect(result.text).toBe("");
    expect(result.values).toBeUndefined();
    // No key → never even constructs a client / calls the SDK.
    expect(called).toBe(false);
  });

  it("renders a 'none yet' inventory when the user has zero apps", async () => {
    setListApps(() => Promise.resolve({ success: true, apps: [] }));
    const result = await cloudAppsProvider.get(
      keyedRuntime(),
      makeMessage("my apps"),
      STATE,
    );
    expect(result.text).toContain("none yet");
    expect(result.values?.cloudAppCount).toBe(0);
  });

  it("respects the 60s cache — a second call within TTL does not re-fetch", async () => {
    let calls = 0;
    setListApps(() => {
      calls += 1;
      return Promise.resolve({
        success: true,
        apps: [makeApp({ name: "Cached App" })],
      });
    });

    // Same runtime object across both calls → cache key identity holds.
    const runtime = keyedRuntime();

    const first = await cloudAppsProvider.get(
      runtime,
      makeMessage("apps"),
      STATE,
    );
    const second = await cloudAppsProvider.get(
      runtime,
      makeMessage("apps"),
      STATE,
    );

    expect(first.text).toContain("Cached App");
    expect(second.text).toContain("Cached App");
    expect(calls).toBe(1);
  });

  it("falls back to a stale cache if a later fetch fails", async () => {
    let calls = 0;
    setListApps(() => {
      calls += 1;
      return Promise.resolve({
        success: true,
        apps: [makeApp({ name: "Warm App" })],
      });
    });

    const runtime = keyedRuntime();
    const first = await cloudAppsProvider.get(
      runtime,
      makeMessage("apps"),
      STATE,
    );
    expect(first.text).toContain("Warm App");
    expect(calls).toBe(1);

    // The first call cached for 60s, so a second call within TTL is served from
    // cache and never reaches the (now-failing) SDK. Inventory stays intact.
    setListApps(() => Promise.reject(new Error("down")));
    const second = await cloudAppsProvider.get(
      runtime,
      makeMessage("apps"),
      STATE,
    );
    expect(second.text).toContain("Warm App");
  });

  it("stays EMPTY when the first fetch fails and there is no cache", async () => {
    setListApps(() => Promise.reject(new Error("down")));
    const result = await cloudAppsProvider.get(
      keyedRuntime(),
      makeMessage("apps"),
      STATE,
    );
    expect(result.text).toBe("");
  });
});
