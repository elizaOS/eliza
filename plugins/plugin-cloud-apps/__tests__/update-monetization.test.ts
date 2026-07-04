/**
 * UPDATE_MONETIZATION tests covering the pure parseMonetizationIntent parser and the range-guarded action. The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { UpdateAppMonetizationInput } from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setListApps,
  setUpdateMonetization,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { updateMonetizationAction } = await import(
  "../src/actions/update-monetization.ts"
);
const { parseMonetizationIntent } = await import(
  "../src/actions/update-monetization.ts"
);
const { cloudAppsProvider } = await import("../src/providers/cloud-apps.ts");

const APP = makeApp({
  id: "id-acme",
  name: "Acme Bot",
  slug: "acme-bot",
  monetization_enabled: true,
});

/** Track updateMonetization calls; echoes settings back as the result. */
function trackMonetization(): {
  calls: Array<{ id: string; settings: UpdateAppMonetizationInput }>;
} {
  const calls: Array<{ id: string; settings: UpdateAppMonetizationInput }> = [];
  setUpdateMonetization((id, settings) => {
    calls.push({ id, settings });
    return Promise.resolve({
      success: true,
      monetization: {
        monetizationEnabled: settings.monetizationEnabled ?? true,
        inferenceMarkupPercentage: settings.inferenceMarkupPercentage ?? 0,
        purchaseSharePercentage: settings.purchaseSharePercentage ?? 0,
        platformOffsetAmount: 0,
        totalCreatorEarnings: 0,
      },
    });
  });
  return { calls };
}

describe("parseMonetizationIntent", () => {
  it("parses a markup percentage and implies enabling", () => {
    const intent = parseMonetizationIntent("set the markup to 20%");
    expect(intent.settings.inferenceMarkupPercentage).toBe(20);
    expect(intent.settings.monetizationEnabled).toBe(true);
  });

  it("parses a disable intent", () => {
    const intent = parseMonetizationIntent("turn off monetization");
    expect(intent.settings.monetizationEnabled).toBe(false);
  });

  it("flags an out-of-range markup", () => {
    expect(parseMonetizationIntent("set markup to 5000%").rejected?.field).toBe(
      "markup",
    );
    expect(parseMonetizationIntent("set markup to -10%").rejected?.field).toBe(
      "markup",
    );
  });
});

describe("UPDATE_MONETIZATION", () => {
  beforeEach(() => {
    resetSdk();
    setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
  });

  it("validates only when a Cloud API key is present", async () => {
    expect(
      await updateMonetizationAction.validate(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await updateMonetizationAction.validate(
        unkeyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(false);
  });

  it("sets the inference markup and echoes the resulting settings", async () => {
    const tracked = trackMonetization();
    const cb = captureCallback();
    const result = await updateMonetizationAction.handler(
      keyedRuntime(),
      makeMessage("set Acme Bot's inference markup to 20%"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(tracked.calls).toHaveLength(1);
    expect(tracked.calls[0]?.settings.inferenceMarkupPercentage).toBe(20);
    expect(result?.success).toBe(true);
    expect(cb.calls[0]?.text).toContain("20%");
  });

  it("disables monetization", async () => {
    const tracked = trackMonetization();
    const cb = captureCallback();
    const result = await updateMonetizationAction.handler(
      keyedRuntime(),
      makeMessage("turn off monetization for Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(tracked.calls[0]?.settings.monetizationEnabled).toBe(false);
    expect(result?.success).toBe(true);
    expect(cb.calls[0]?.text?.toUpperCase()).toContain("OFF");
  });

  it("rejects an out-of-range markup WITHOUT calling the API", async () => {
    const tracked = trackMonetization();
    const cb = captureCallback();
    const result = await updateMonetizationAction.handler(
      keyedRuntime(),
      makeMessage("set Acme Bot markup to 5000%"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(tracked.calls).toHaveLength(0);
    expect((result?.data as { reason: string }).reason).toBe("out_of_range");
    expect(cb.calls[0]?.text?.toLowerCase()).toContain("out of range");
  });

  it("rejects a negative markup", async () => {
    const tracked = trackMonetization();
    const result = await updateMonetizationAction.handler(
      keyedRuntime(),
      makeMessage("set Acme Bot markup to -10%"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect(tracked.calls).toHaveLength(0);
    expect((result?.data as { reason: string }).reason).toBe("out_of_range");
  });

  it("asks what to change when nothing is parseable", async () => {
    const tracked = trackMonetization();
    const result = await updateMonetizationAction.handler(
      keyedRuntime(),
      makeMessage("do something with monetization later"),
      undefined,
      { appName: "Acme Bot" },
      captureCallback().fn,
    );
    expect(tracked.calls).toHaveLength(0);
    expect((result?.data as { reason: string }).reason).toBe("no_change");
  });

  it("degrades gracefully with no Cloud API key", async () => {
    const result = await updateMonetizationAction.handler(
      unkeyedRuntime(),
      makeMessage("set Acme Bot markup to 20%"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect((result?.data as { reason: string }).reason).toBe("no_key");
  });

  it("surfaces a monetization API error", async () => {
    setUpdateMonetization(() => Promise.reject(new Error("boom")));
    const result = await updateMonetizationAction.handler(
      keyedRuntime(),
      makeMessage("set Acme Bot's markup to 20%"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("error");
  });

  it("invalidates the CLOUD_APPS provider cache after a successful change", async () => {
    const runtime = keyedRuntime();
    let listCalls = 0;
    setListApps(() => {
      listCalls += 1;
      return Promise.resolve({ success: true, apps: [APP] });
    });
    trackMonetization();

    await cloudAppsProvider.get(runtime, makeMessage("my apps"), {} as never);
    const primedCalls = listCalls;
    await cloudAppsProvider.get(runtime, makeMessage("my apps"), {} as never);
    expect(listCalls).toBe(primedCalls);

    const result = await updateMonetizationAction.handler(
      runtime,
      makeMessage("set Acme Bot's markup to 20%"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect(result?.success).toBe(true);

    const afterAction = listCalls;
    await cloudAppsProvider.get(runtime, makeMessage("my apps"), {} as never);
    expect(listCalls).toBe(afterAction + 1);
  });
});
