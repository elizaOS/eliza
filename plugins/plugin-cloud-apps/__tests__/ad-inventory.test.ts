/**
 * Ad-inventory action tests (CREATE_AD_SLOT and related slot management). The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { CreateAdSlotInput } from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setCreateAdSlot,
  setGetApp,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { createAdSlotAction, listAdSlotsAction } = await import(
  "../src/actions/ad-inventory.ts"
);

const APP = makeApp({ id: "app_1", name: "Acme Bot", slug: "acme-bot" });

describe("CREATE_AD_SLOT", () => {
  beforeEach(() => {
    resetSdk();
    setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
    setGetApp(() => Promise.resolve({ success: true, app: APP }));
  });

  it("validate: true with key, false without", async () => {
    expect(
      await createAdSlotAction.validate(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await createAdSlotAction.validate(unkeyedRuntime(), makeMessage("x")),
    ).toBe(false);
  });

  it("no key → no_key", async () => {
    const cb = captureCallback();
    const res = await createAdSlotAction.handler(
      unkeyedRuntime(),
      makeMessage("monetize Acme Bot"),
      undefined,
      {},
      cb.callback,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "no_key" });
  });

  it("unknown app → not_found", async () => {
    setListApps(() => Promise.resolve({ success: true, apps: [] }));
    setGetApp(() =>
      Promise.resolve({ success: true, app: undefined as never }),
    );
    const cb = captureCallback();
    const res = await createAdSlotAction.handler(
      keyedRuntime(),
      makeMessage("monetize Nope"),
      undefined,
      {},
      cb.callback,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "not_found" });
  });

  it("creates an ad slot on the resolved app", async () => {
    let captured: CreateAdSlotInput | null = null;
    setCreateAdSlot((input) => {
      captured = input;
      return Promise.resolve({
        success: true,
        slot: {
          id: "slot_x",
          app_id: "app_1",
          name: input.name,
          format: input.format,
          status: "active",
          floor_cpm: "20.0000",
          total_impressions: 0,
          total_clicks: 0,
          total_revenue: "0.000000",
        },
        adTagToken: "v1.9999999999.cafebabe",
      });
    });
    const cb = captureCallback();
    const res = await createAdSlotAction.handler(
      keyedRuntime(),
      makeMessage("monetize an app"),
      undefined,
      { app: "Acme Bot", slotName: "Header", format: "native", floorCpm: 20 },
      cb.callback,
    );
    expect(res.success).toBe(true);
    expect(captured).toMatchObject({
      appId: "app_1",
      name: "Header",
      format: "native",
      floorCpm: 20,
    });
    // The signed serve capability is surfaced to the caller.
    expect(res.data).toMatchObject({ adTagToken: "v1.9999999999.cafebabe" });
  });
});

describe("LIST_AD_SLOTS", () => {
  beforeEach(() => resetSdk());

  it("reports empty inventory", async () => {
    const cb = captureCallback();
    const res = await listAdSlotsAction.handler(
      keyedRuntime(),
      makeMessage("my ad slots"),
      undefined,
      undefined,
      cb.callback,
    );
    expect(res.success).toBe(true);
    expect(res.userFacingText).toContain("don't have any ad slots");
  });
});
