import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { CreateBookingInput } from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeMessage,
  resetSdk,
  setCreateBooking,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({ ElizaCloudClient: FakeElizaCloudClient }));

const { bookInfluencerAction } = await import("../src/actions/book-influencer.ts");

describe("BOOK_INFLUENCER (two-phase money confirm)", () => {
  beforeEach(() => resetSdk());

  it("validate: true with key, false without", async () => {
    expect(await bookInfluencerAction.validate(keyedRuntime(), makeMessage("x"))).toBe(true);
    expect(await bookInfluencerAction.validate(unkeyedRuntime(), makeMessage("x"))).toBe(false);
  });

  it("no key → no_key, no money call", async () => {
    let called = false;
    setCreateBooking((i) => {
      called = true;
      return Promise.resolve({ success: true, booking: { id: "b", advertiser_org_id: "o", influencer_profile_id: i.profileId, amount: String(i.amount), status: "offered", brief: i.brief } });
    });
    const cb = captureCallback();
    const res = await bookInfluencerAction.handler(unkeyedRuntime(), makeMessage("hire Nova for $200"), undefined, { profileId: "inf_1", amount: 200 }, cb.callback);
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "no_key" });
    expect(called).toBe(false);
  });

  it("first ask NEVER books; explicit confirm books exactly once", async () => {
    const runtime = keyedRuntime();
    let captured: CreateBookingInput | null = null;
    let calls = 0;
    setCreateBooking((i) => {
      calls += 1;
      captured = i;
      return Promise.resolve({ success: true, booking: { id: "bk", advertiser_org_id: "o", influencer_profile_id: i.profileId, amount: String(i.amount), status: "offered", brief: i.brief } });
    });

    // Phase 1 — first ask: confirmation required, NO booking.
    const ask = await bookInfluencerAction.handler(
      runtime,
      makeMessage("hire Nova to promote my app for $200"),
      undefined,
      { profileId: "inf_1", influencer: "Nova", amount: 200, brief: "post about us" },
      captureCallback().callback,
    );
    expect((ask?.data as { confirmationRequired?: boolean }).confirmationRequired).toBe(true);
    expect(calls).toBe(0);

    // Phase 2 — confirm on the SAME runtime: books once.
    const confirmCb = captureCallback();
    const done = await bookInfluencerAction.handler(runtime, makeMessage("yes confirm"), undefined, { confirm: true }, confirmCb.callback);
    expect(done.success).toBe(true);
    expect(calls).toBe(1);
    expect(captured).toMatchObject({ profileId: "inf_1", amount: 200, brief: "post about us" });
  });

  it("cancel: no booking", async () => {
    const runtime = keyedRuntime();
    let calls = 0;
    setCreateBooking((i) => {
      calls += 1;
      return Promise.resolve({ success: true, booking: { id: "bk", advertiser_org_id: "o", influencer_profile_id: i.profileId, amount: String(i.amount), status: "offered", brief: i.brief } });
    });
    await bookInfluencerAction.handler(runtime, makeMessage("hire Nova for $50"), undefined, { profileId: "inf_1", amount: 50 }, captureCallback().callback);
    const res = await bookInfluencerAction.handler(runtime, makeMessage("no cancel"), undefined, { confirm: false }, captureCallback().callback);
    expect(res.data).toMatchObject({ canceled: true });
    expect(calls).toBe(0);
  });

  it("confirm with no pending → no_pending_confirmation", async () => {
    const cb = captureCallback();
    const res = await bookInfluencerAction.handler(keyedRuntime(), makeMessage("yes"), undefined, { confirm: true }, cb.callback);
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "no_pending_confirmation" });
  });
});
