/**
 * BOOK_INFLUENCER action tests, including the two-phase money confirm before a paid booking. The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
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
const {
  CONFIRM_TTL_MS,
  findPendingCloudAppConfirmation,
  persistCloudAppConfirmation,
} = await import("../src/safety.ts");

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

  it("MONEY: confirm naming a DIFFERENT influencer refuses, funds nothing, clears the pending", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBookings();
    await bookInfluencerAction.handler(
      runtime,
      makeMessage("hire Nova to promote my app for $200"),
      undefined,
      { profileId: "inf_1", influencer: "Nova", amount: 200, brief: "post" },
      captureCallback().fn,
    );

    const cb = captureCallback();
    const result = await bookInfluencerAction.handler(
      runtime,
      makeMessage("yes — book Blaze instead"),
      undefined,
      { parameters: { confirm: true, influencer: "Blaze" } },
      cb.fn,
    );

    expect(calls).toHaveLength(0);
    expect(result.success).toBe(false);
    expect((result.data as { reason: string }).reason).toBe(
      "confirm_target_mismatch",
    );
    const reply = cb.calls.at(-1)?.text ?? "";
    expect(reply).toContain("Blaze");
    expect(reply).toContain("Nova");

    // Pending cleared: a later bare confirm cannot fund the stale booking.
    const followUp = await bookInfluencerAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      captureCallback().fn,
    );
    expect(calls).toHaveLength(0);
    expect((followUp.data as { reason: string }).reason).toBe(
      "no_pending_confirmation",
    );
  });

  it("MONEY: confirm carrying a DIFFERENT structured budget refuses (frozen $200 vs turn $999)", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackBookings();
    await bookInfluencerAction.handler(
      runtime,
      makeMessage("hire Nova for $200"),
      undefined,
      { profileId: "inf_1", influencer: "Nova", amount: 200, brief: "post" },
      captureCallback().fn,
    );
    const result = await bookInfluencerAction.handler(
      runtime,
      makeMessage("confirm at $999"),
      undefined,
      { parameters: { confirm: true, amount: 999 } },
      captureCallback().fn,
    );
    expect(calls).toHaveLength(0);
    expect((result.data as { reason: string }).reason).toBe(
      "confirm_target_mismatch",
    );

    // Re-ask + a confirm that re-names the SAME influencer and budget books.
    await bookInfluencerAction.handler(
      runtime,
      makeMessage("hire Nova for $200"),
      undefined,
      { profileId: "inf_1", influencer: "Nova", amount: 200, brief: "post" },
      captureCallback().fn,
    );
    const ok = await bookInfluencerAction.handler(
      runtime,
      makeMessage("yes book Nova for $200"),
      undefined,
      { parameters: { confirm: true, influencer: "Nova", amount: 200 } },
      captureCallback().fn,
    );
    expect(ok.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.amount).toBe(200);
    expect(calls[0]?.profileId).toBe("inf_1");
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

/**
 * Stateful fake escrow mirroring the SERVER's createBooking/fundBooking
 * semantics (packages/cloud/shared/src/lib/services/influencer-marketplace.ts):
 * a keyed debit ledger + a funding→offered finalize, where a same-key call
 * resumes/replays the original booking without a second debit and a failed
 * debit retires the funding row. Lets the tests count REAL credit holds across
 * retries instead of just counting calls — a retry that mints a NEW key funds
 * a second escrow here exactly like it would in production (#11844).
 */
class FakeEscrow {
  /** Advertiser credit holds, one per funded booking — the money under guard. */
  holds: Array<{ key: string; amount: number }> = [];
  bookings = new Map<
    string,
    { id: string; status: "funding" | "offered"; amount: number }
  >();
  calls: CreateBookingInput[] = [];
  /** Failure injected into the NEXT fresh (non-resume) fund call. */
  failNext:
    | "none"
    | "response_lost"
    | "crash_in_funding"
    | "insufficient_credits" = "none";

  install(): void {
    setCreateBooking((input) => {
      this.calls.push(input);
      const key = input.idempotencyKey ?? `anon-${this.calls.length}`;
      const existing = this.bookings.get(key);
      if (existing) {
        // Same-key resume/replay: drive a crashed `funding` row to `offered`
        // (or return the already-offered booking) with NO new debit.
        existing.status = "offered";
        return Promise.resolve(this.ok(existing, input));
      }
      const mode = this.failNext;
      this.failNext = "none";
      if (mode === "insufficient_credits") {
        // Clean business rejection: debit failed, funding row retired —
        // no hold, no resumable state. Duck-typed CloudApiError (402).
        return Promise.reject(
          Object.assign(new Error("Insufficient credits"), {
            statusCode: 402,
            errorBody: { success: false, error: "Insufficient credits" },
          }),
        );
      }
      // The keyed debit — THE hold this whole suite is guarding.
      this.holds.push({ key, amount: input.amount });
      const booking = {
        id: `bk_${this.bookings.size + 1}`,
        status:
          mode === "crash_in_funding"
            ? ("funding" as const)
            : ("offered" as const),
        amount: input.amount,
      };
      this.bookings.set(key, booking);
      if (mode === "response_lost" || mode === "crash_in_funding") {
        // Transport-level failure AFTER the server committed money state:
        // the client never sees a status code.
        return Promise.reject(new TypeError("fetch failed: network dropped"));
      }
      return Promise.resolve(this.ok(booking, input));
    });
  }

  private ok(
    booking: { id: string; status: "funding" | "offered"; amount: number },
    input: CreateBookingInput,
  ) {
    return {
      success: true as const,
      booking: {
        id: booking.id,
        advertiser_org_id: "org",
        influencer_profile_id: input.profileId,
        amount: String(booking.amount),
        status: booking.status,
        brief: input.brief,
      },
    };
  }
}

describe("BOOK_INFLUENCER escrow idempotency-key survival (#11844)", () => {
  beforeEach(() => resetSdk());

  function roomOf(runtime: ReturnType<typeof keyedRuntime>): string {
    return String(runtime.agentId);
  }

  async function stagePending(
    runtime: ReturnType<typeof keyedRuntime>,
  ): Promise<void> {
    await bookInfluencerAction.handler(
      runtime,
      makeMessage("hire Nova for $200"),
      undefined,
      { profileId: "inf_1", influencer: "Nova", amount: 200, brief: "post" },
      undefined,
    );
  }

  async function confirm(runtime: ReturnType<typeof keyedRuntime>) {
    return bookInfluencerAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      undefined,
    );
  }

  it("lane (a) fund committed + response lost: the pending/key survives and the re-confirm replays the SAME escrow — one hold, one key", async () => {
    const runtime = keyedRuntime();
    const escrow = new FakeEscrow();
    escrow.install();
    await stagePending(runtime);

    escrow.failNext = "response_lost";
    const failed = await confirm(runtime);
    expect(failed.success).toBe(false);
    expect(failed.userFacingText).toContain("retry safely");
    // The server DID commit before the response was lost.
    expect(escrow.holds.length).toBe(1);

    // The pending survived the transport failure: same task, marked recovery,
    // still the sole holder of the key the first attempt used.
    const pending = await findPendingCloudAppConfirmation(
      runtime,
      roomOf(runtime),
      "BOOK_INFLUENCER",
    );
    expect(pending).not.toBeNull();
    expect(pending?.metadata.recovery).toBe(true);
    expect(escrow.calls[0]?.idempotencyKey).toBe(
      `influencer-confirm-${pending?.taskId}`,
    );

    // Re-confirm: the SAME key replays the booking — NO second hold. (Before
    // the fix the pending died with the first confirm, so this retry carried
    // a NEW key and funded a SECOND escrow.)
    const done = await confirm(runtime);
    expect(done.success).toBe(true);
    expect(done.data).toMatchObject({ booked: true, recovery: true });
    expect(escrow.calls.length).toBe(2);
    expect(escrow.calls[1]?.idempotencyKey).toBe(
      escrow.calls[0]?.idempotencyKey,
    );
    expect(escrow.holds.length).toBe(1);
    // Settled: the pending (and its key) is done with.
    expect(
      await findPendingCloudAppConfirmation(
        runtime,
        roomOf(runtime),
        "BOOK_INFLUENCER",
      ),
    ).toBeNull();
  });

  it("lane (b) crash between keyed debit and finalize: the same-key re-confirm resumes 'funding' to terminal 'offered' with no second debit", async () => {
    const runtime = keyedRuntime();
    const escrow = new FakeEscrow();
    escrow.install();
    await stagePending(runtime);

    escrow.failNext = "crash_in_funding";
    const failed = await confirm(runtime);
    expect(failed.success).toBe(false);
    const key = escrow.calls[0]?.idempotencyKey as string;
    // Stranded server state: debited, stuck in `funding` — no API transition
    // accepts it; only a same-key retry can repair it.
    expect(escrow.bookings.get(key)?.status).toBe("funding");
    expect(escrow.holds.length).toBe(1);

    const done = await confirm(runtime);
    expect(done.success).toBe(true);
    expect(escrow.calls[1]?.idempotencyKey).toBe(key);
    // Repaired to a terminal, user-actionable state — and still one debit.
    expect(escrow.bookings.get(key)?.status).toBe("offered");
    expect(escrow.holds.length).toBe(1);
  });

  it("the recovery retry is TTL-exempt: an aged recovery pending still repairs with the SAME key", async () => {
    const runtime = keyedRuntime();
    const escrow = new FakeEscrow();
    escrow.install();
    await stagePending(runtime);

    escrow.failNext = "crash_in_funding";
    await confirm(runtime);
    const pending = await findPendingCloudAppConfirmation(
      runtime,
      roomOf(runtime),
      "BOOK_INFLUENCER",
    );
    expect(pending?.metadata.recovery).toBe(true);
    // Age the recovery pending far past the confirm TTL.
    await runtime.updateTask(pending?.taskId as never, {
      metadata: {
        ...pending?.metadata,
        intentCreatedAt: new Date(
          Date.now() - CONFIRM_TTL_MS - 60_000,
        ).toISOString(),
      },
    });

    // A plain pending would refuse the bare confirm here; the recovery one
    // must still complete — expiring it would strand the `funding` debit.
    const done = await confirm(runtime);
    expect(done.success).toBe(true);
    expect(escrow.calls[1]?.idempotencyKey).toBe(
      escrow.calls[0]?.idempotencyKey,
    );
    expect(escrow.holds.length).toBe(1);
  });

  it("a definite 4xx rejection (insufficient credits) settles the confirm: nothing held, pending deleted, no recovery staged", async () => {
    const runtime = keyedRuntime();
    const escrow = new FakeEscrow();
    escrow.install();
    await stagePending(runtime);

    escrow.failNext = "insufficient_credits";
    const res = await confirm(runtime);
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({
      reason: "insufficient_credits",
      booked: false,
    });
    expect(res.userFacingText).toContain("nothing was funded");
    expect(escrow.holds.length).toBe(0);
    expect(
      await findPendingCloudAppConfirmation(
        runtime,
        roomOf(runtime),
        "BOOK_INFLUENCER",
      ),
    ).toBeNull();

    // No zombie retry: a later bare confirm has nothing to fund.
    const again = await confirm(runtime);
    expect(again.data).toMatchObject({ reason: "no_pending_confirmation" });
    expect(escrow.calls.length).toBe(1);
  });

  it("canceling a recovery pending deletes it and is honest that the escrow may already be held", async () => {
    const runtime = keyedRuntime();
    const escrow = new FakeEscrow();
    escrow.install();
    await stagePending(runtime);

    escrow.failNext = "response_lost";
    await confirm(runtime);

    const res = await bookInfluencerAction.handler(
      runtime,
      makeMessage("no, cancel"),
      undefined,
      { confirm: false },
      undefined,
    );
    expect(res.data).toMatchObject({ canceled: true, recovery: true });
    expect(res.userFacingText).toContain("may already exist");
    expect(
      await findPendingCloudAppConfirmation(
        runtime,
        roomOf(runtime),
        "BOOK_INFLUENCER",
      ),
    ).toBeNull();
    // Canceling never silently funded anything new.
    expect(escrow.calls.length).toBe(1);
    expect(escrow.holds.length).toBe(1);
  });

  it("a new ask while a recovery pending waits re-prompts the safe retry instead of minting a new key", async () => {
    const runtime = keyedRuntime();
    const escrow = new FakeEscrow();
    escrow.install();
    await stagePending(runtime);

    escrow.failNext = "response_lost";
    await confirm(runtime);

    // A fresh phase-1 ask (different influencer) must not stack a second
    // pending — the recovery (and its key) stays the one thing to settle.
    const ask = await bookInfluencerAction.handler(
      runtime,
      makeMessage("hire Mallory for $500"),
      undefined,
      { profileId: "inf_2", influencer: "Mallory", amount: 500, brief: "x" },
      undefined,
    );
    expect(ask.data).toMatchObject({
      confirmationRequired: true,
      profileId: "inf_1",
      amount: 200,
    });
    expect(ask.userFacingText).toContain("retry safely");

    const done = await confirm(runtime);
    expect(done.success).toBe(true);
    expect(escrow.calls.length).toBe(2);
    expect(escrow.calls[1]?.idempotencyKey).toBe(
      escrow.calls[0]?.idempotencyKey,
    );
    expect(escrow.holds.length).toBe(1);
  });

  it("a mismatched confirm against a recovery pending refuses but keeps the same-key repair pending alive", async () => {
    const runtime = keyedRuntime();
    const escrow = new FakeEscrow();
    escrow.install();
    await stagePending(runtime);

    escrow.failNext = "response_lost";
    await confirm(runtime);
    const pending = await findPendingCloudAppConfirmation(
      runtime,
      roomOf(runtime),
      "BOOK_INFLUENCER",
    );
    expect(pending?.metadata.recovery).toBe(true);

    const mismatch = await bookInfluencerAction.handler(
      runtime,
      makeMessage("yes, book Mallory instead"),
      undefined,
      { parameters: { confirm: true, influencer: "Mallory" } },
      undefined,
    );
    expect(mismatch.success).toBe(false);
    expect(mismatch.data).toMatchObject({
      reason: "confirm_target_mismatch",
      recovery: true,
    });
    expect(escrow.calls.length).toBe(1);
    expect(escrow.holds.length).toBe(1);

    const stillPending = await findPendingCloudAppConfirmation(
      runtime,
      roomOf(runtime),
      "BOOK_INFLUENCER",
    );
    expect(stillPending?.taskId).toBe(pending?.taskId);
    expect(stillPending?.metadata.recovery).toBe(true);

    const repaired = await confirm(runtime);
    expect(repaired.success).toBe(true);
    expect(escrow.calls[1]?.idempotencyKey).toBe(
      escrow.calls[0]?.idempotencyKey,
    );
    expect(escrow.holds.length).toBe(1);
  });
});
