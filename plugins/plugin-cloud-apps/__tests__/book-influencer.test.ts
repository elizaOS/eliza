import { beforeEach, describe, expect, it, mock } from "bun:test";
import type {
  CreateBookingInput,
  InfluencerProfileDto,
} from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeMessage,
  resetSdk,
  setCreateBooking,
  setListInfluencers,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { bookInfluencerAction } = await import(
  "../src/actions/book-influencer.ts"
);
const { CONFIRM_TTL_MS, persistCloudAppConfirmation } = await import(
  "../src/safety.ts"
);

function profile(id: string, displayName: string): InfluencerProfileDto {
  return {
    id,
    display_name: displayName,
    niche: null,
    bio: null,
    platforms: [],
    status: "active",
  };
}

/** Install a booking tracker: counts calls and captures the last input. */
function trackBookings(): {
  calls: CreateBookingInput[];
} {
  const calls: CreateBookingInput[] = [];
  setCreateBooking((i) => {
    calls.push(i);
    return Promise.resolve({
      success: true,
      booking: {
        id: "bk",
        advertiser_org_id: "o",
        influencer_profile_id: i.profileId,
        amount: String(i.amount),
        status: "offered",
        brief: i.brief,
      },
    });
  });
  return { calls };
}

describe("BOOK_INFLUENCER (two-phase money confirm)", () => {
  beforeEach(() => resetSdk());

  it("validate: true with key, false without", async () => {
    expect(
      await bookInfluencerAction.validate(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await bookInfluencerAction.validate(unkeyedRuntime(), makeMessage("x")),
    ).toBe(false);
  });

  it("no key → no_key, no money call", async () => {
    let called = false;
    setCreateBooking((i) => {
      called = true;
      return Promise.resolve({
        success: true,
        booking: {
          id: "b",
          advertiser_org_id: "o",
          influencer_profile_id: i.profileId,
          amount: String(i.amount),
          status: "offered",
          brief: i.brief,
        },
      });
    });
    const cb = captureCallback();
    const res = await bookInfluencerAction.handler(
      unkeyedRuntime(),
      makeMessage("hire Nova for $200"),
      undefined,
      { profileId: "inf_1", amount: 200 },
      cb.callback,
    );
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
      return Promise.resolve({
        success: true,
        booking: {
          id: "bk",
          advertiser_org_id: "o",
          influencer_profile_id: i.profileId,
          amount: String(i.amount),
          status: "offered",
          brief: i.brief,
        },
      });
    });

    // Phase 1 — first ask: confirmation required, NO booking.
    const ask = await bookInfluencerAction.handler(
      runtime,
      makeMessage("hire Nova to promote my app for $200"),
      undefined,
      {
        profileId: "inf_1",
        influencer: "Nova",
        amount: 200,
        brief: "post about us",
      },
      captureCallback().callback,
    );
    expect(
      (ask?.data as { confirmationRequired?: boolean }).confirmationRequired,
    ).toBe(true);
    expect(calls).toBe(0);

    // Phase 2 — confirm on the SAME runtime: books once.
    const confirmCb = captureCallback();
    const done = await bookInfluencerAction.handler(
      runtime,
      makeMessage("yes confirm"),
      undefined,
      { confirm: true },
      confirmCb.callback,
    );
    expect(done.success).toBe(true);
    expect(calls).toBe(1);
    expect(captured).toMatchObject({
      profileId: "inf_1",
      amount: 200,
      brief: "post about us",
    });
    // Money-safety: the confirm carries a stable idempotency key so a
    // transport-level retry cannot fund a second escrow.
    expect(captured?.idempotencyKey).toMatch(/^influencer-confirm-.+/);
  });

  it("a transport failure keeps the pending so a retry reuses the SAME escrow idempotency key (#11844)", async () => {
    const runtime = keyedRuntime();
    const keys: string[] = [];
    let n = 0;
    setCreateBooking((i) => {
      keys.push(i.idempotencyKey ?? "");
      n += 1;
      // First fund attempt: a transport-level failure (thrown, no response).
      if (n === 1) return Promise.reject(new Error("network down"));
      return Promise.resolve({
        success: true,
        booking: {
          id: "bk",
          advertiser_org_id: "o",
          influencer_profile_id: i.profileId,
          amount: String(i.amount),
          status: "offered",
          brief: i.brief,
        },
      });
    });

    // Phase 1 — ask persists a pending (the sole holder of the idempotency key).
    await bookInfluencerAction.handler(
      runtime,
      makeMessage("hire Nova to promote my app for $200"),
      undefined,
      {
        profileId: "inf_1",
        influencer: "Nova",
        amount: 200,
        brief: "post about us",
      },
      captureCallback().callback,
    );

    // Phase 2 — confirm; the fund call THROWS. Must fail WITHOUT losing the pending.
    const first = await bookInfluencerAction.handler(
      runtime,
      makeMessage("yes confirm"),
      undefined,
      { confirm: true },
      captureCallback().callback,
    );
    expect(first.success).toBe(false);

    // Retry the bare confirm — the pending survived, so the fund runs again with
    // the SAME idempotency key (the escrow service dedups the crash-repair).
    // Before the fix the pending was deleted BEFORE the throw, so this retry
    // would find no pending (no_pending_confirmation) and never re-fund.
    const second = await bookInfluencerAction.handler(
      runtime,
      makeMessage("yes confirm"),
      undefined,
      { confirm: true },
      captureCallback().callback,
    );
    expect(second.success).toBe(true);
    expect(keys.length).toBe(2);
    expect(keys[0]).toMatch(/^influencer-confirm-.+/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("cancel: no booking", async () => {
    const runtime = keyedRuntime();
    let calls = 0;
    setCreateBooking((i) => {
      calls += 1;
      return Promise.resolve({
        success: true,
        booking: {
          id: "bk",
          advertiser_org_id: "o",
          influencer_profile_id: i.profileId,
          amount: String(i.amount),
          status: "offered",
          brief: i.brief,
        },
      });
    });
    await bookInfluencerAction.handler(
      runtime,
      makeMessage("hire Nova for $50"),
      undefined,
      { profileId: "inf_1", amount: 50 },
      captureCallback().callback,
    );
    const res = await bookInfluencerAction.handler(
      runtime,
      makeMessage("no cancel"),
      undefined,
      { confirm: false },
      captureCallback().callback,
    );
    expect(res.data).toMatchObject({ canceled: true });
    expect(calls).toBe(0);
  });

  it("confirm with no pending → no_pending_confirmation", async () => {
    const cb = captureCallback();
    const res = await bookInfluencerAction.handler(
      keyedRuntime(),
      makeMessage("yes"),
      undefined,
      { confirm: true },
      cb.callback,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "no_pending_confirmation" });
  });
});

describe("BOOK_INFLUENCER pending-stacking + TTL guards", () => {
  beforeEach(() => resetSdk());

  it("a second ask while one is pending re-prompts; a later confirm funds only the FIRST ask", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBookings();

    await bookInfluencerAction.handler(
      runtime,
      makeMessage("hire Nova for $200"),
      undefined,
      { profileId: "inf_1", influencer: "Nova", amount: 200, brief: "post" },
      undefined,
    );

    // Second first-phase ask (different influencer + amount) must NOT stack a
    // second pending — it re-prompts for the one already waiting.
    const second = captureCallback();
    const res = await bookInfluencerAction.handler(
      runtime,
      makeMessage("actually hire Mallory for $500"),
      undefined,
      { profileId: "inf_2", influencer: "Mallory", amount: 500, brief: "x" },
      second.fn,
    );
    expect(res.data).toMatchObject({
      confirmationRequired: true,
      profileId: "inf_1",
      amount: 200,
    });
    expect(res.userFacingText).toContain("still waiting");
    expect(calls.length).toBe(0);

    // The bare confirm funds the booking the user was actually shown.
    const done = await bookInfluencerAction.handler(
      runtime,
      makeMessage("yes confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(done.success).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ profileId: "inf_1", amount: 200 });
  });

  it("a confirm against an aged pending refuses, funds nothing, and deletes the pending", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBookings();
    await persistCloudAppConfirmation(runtime, {
      roomId: String(runtime.agentId),
      action: "BOOK_INFLUENCER",
      appId: "inf_1",
      appName: "Nova",
      amount: 200,
      brief: "post about us",
      intentCreatedAt: new Date(
        Date.now() - CONFIRM_TTL_MS - 1000,
      ).toISOString(),
    });

    const res = await bookInfluencerAction.handler(
      runtime,
      makeMessage("yes confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({
      reason: "confirmation_expired",
      booked: false,
    });
    expect(calls.length).toBe(0);

    // The stale pending is gone: a second bare confirm finds nothing to fund.
    const again = await bookInfluencerAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(again.data).toMatchObject({ reason: "no_pending_confirmation" });
    expect(calls.length).toBe(0);
  });

  it("a fresh ask replaces a stale pending (at most one pending per room)", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBookings();
    await persistCloudAppConfirmation(runtime, {
      roomId: String(runtime.agentId),
      action: "BOOK_INFLUENCER",
      appId: "inf_old",
      appName: "Old Guy",
      amount: 999,
      brief: "stale",
      intentCreatedAt: new Date(
        Date.now() - CONFIRM_TTL_MS - 1000,
      ).toISOString(),
    });

    const ask = await bookInfluencerAction.handler(
      runtime,
      makeMessage("hire Nova for $200"),
      undefined,
      { profileId: "inf_1", influencer: "Nova", amount: 200, brief: "post" },
      undefined,
    );
    expect(ask.data).toMatchObject({
      confirmationRequired: true,
      profileId: "inf_1",
    });

    const done = await bookInfluencerAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(done.success).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ profileId: "inf_1", amount: 200 });
  });
});

describe("BOOK_INFLUENCER budget parsing (currency cue required)", () => {
  beforeEach(() => resetSdk());

  it('a bare number in the message is NOT a budget ("book Nova, she has 80000 followers")', async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBookings();
    setListInfluencers(() =>
      Promise.resolve({ success: true, profiles: [profile("inf_1", "Nova")] }),
    );

    const ask = captureCallback();
    const res = await bookInfluencerAction.handler(
      runtime,
      makeMessage("book Nova, she has 80000 followers"),
      undefined,
      { influencer: "Nova" },
      ask.fn,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "missing_input" });
    expect(res.userFacingText).toContain("budget");
    expect(calls.length).toBe(0);

    // Nothing was persisted: a bare confirm has nothing to fund.
    const confirm = await bookInfluencerAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(confirm.data).toMatchObject({ reason: "no_pending_confirmation" });
    expect(calls.length).toBe(0);
  });

  it('cue\'d text amounts parse: "$50", "50 bucks", "50 usd"', async () => {
    setListInfluencers(() =>
      Promise.resolve({ success: true, profiles: [profile("inf_1", "Nova")] }),
    );
    for (const [text, expected] of [
      ["hire Nova for $50", 50],
      ["hire Nova for 50 bucks", 50],
      ["hire Nova for 50 usd", 50],
      ["hire Nova for 12.50 dollars", 12.5],
    ] as const) {
      const res = await bookInfluencerAction.handler(
        keyedRuntime(),
        makeMessage(text),
        undefined,
        undefined,
        undefined,
      );
      expect(res.data).toMatchObject({
        confirmationRequired: true,
        amount: expected,
      });
    }
  });

  it("reads the nested options.parameters amount first (real planner path)", async () => {
    const res = await bookInfluencerAction.handler(
      keyedRuntime(),
      makeMessage("book Nova"),
      undefined,
      {
        parameters: {
          profileId: "inf_1",
          influencer: "Nova",
          amount: 75,
          brief: "post",
        },
      },
      undefined,
    );
    expect(res.data).toMatchObject({
      confirmationRequired: true,
      profileId: "inf_1",
      amount: 75,
    });
  });
});

describe("BOOK_INFLUENCER influencer resolution (ambiguity-aware)", () => {
  beforeEach(() => resetSdk());

  it("an ambiguous reference asks to disambiguate instead of booking a lookalike", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBookings();
    setListInfluencers(() =>
      Promise.resolve({
        success: true,
        profiles: [profile("inf_a", "Nova Cat"), profile("inf_b", "Nova Dog")],
      }),
    );

    const res = await bookInfluencerAction.handler(
      runtime,
      makeMessage("book Nova for $100"),
      undefined,
      { influencer: "Nova", amount: 100 },
      undefined,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({
      reason: "ambiguous",
      candidates: ["Nova Cat", "Nova Dog"],
    });
    expect(res.userFacingText).toContain("Nova Cat");
    expect(res.userFacingText).toContain("Nova Dog");
    expect(calls.length).toBe(0);

    // No pending was staged for either candidate.
    const confirm = await bookInfluencerAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
    expect(confirm.data).toMatchObject({ reason: "no_pending_confirmation" });
    expect(calls.length).toBe(0);
  });

  it("an adversarial substring profile cannot capture the booking (whole-word beats fragment)", async () => {
    // Old first-match `ref.includes(name)` resolution: a profile named "Pro"
    // captured "hire Nova to promote my app…" via the "pro" inside "promote".
    setListInfluencers(() =>
      Promise.resolve({
        success: true,
        profiles: [profile("inf_bad", "Pro"), profile("inf_good", "Nova")],
      }),
    );
    const res = await bookInfluencerAction.handler(
      keyedRuntime(),
      makeMessage("hire Nova to promote my app for $200"),
      undefined,
      undefined,
      undefined,
    );
    expect(res.data).toMatchObject({
      confirmationRequired: true,
      profileId: "inf_good",
      amount: 200,
    });
  });

  it("exact display-name match still resolves directly", async () => {
    setListInfluencers(() =>
      Promise.resolve({
        success: true,
        profiles: [profile("inf_1", "Nova"), profile("inf_2", "Mallory")],
      }),
    );
    const res = await bookInfluencerAction.handler(
      keyedRuntime(),
      makeMessage("book her"),
      undefined,
      { influencer: "nova", amount: 40 },
      undefined,
    );
    expect(res.data).toMatchObject({
      confirmationRequired: true,
      profileId: "inf_1",
      amount: 40,
    });
  });
});
