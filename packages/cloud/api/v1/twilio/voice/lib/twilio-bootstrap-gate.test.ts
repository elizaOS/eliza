/** Proves unauthenticated Twilio socket admission is bounded and configuration fails closed. */

import { describe, expect, test } from "bun:test";
import {
  awaitTwilioBootstrapPhase,
  resolveTwilioBootstrapLimits,
  TwilioBootstrapGate,
} from "./twilio-bootstrap-gate";

describe("Twilio bootstrap admission", () => {
  test("caps pending unauthenticated sockets and releases capacity once", () => {
    const gate = new TwilioBootstrapGate();
    const first = gate.tryAcquire(2);
    const second = gate.tryAcquire(2);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(gate.tryAcquire(2)).toBeNull();
    expect(gate.pendingCount()).toBe(2);

    first?.release();
    first?.release();
    expect(gate.pendingCount()).toBe(1);
    expect(gate.tryAcquire(2)).not.toBeNull();
  });

  test("uses bounded defaults and rejects malformed or excessive limits", () => {
    expect(resolveTwilioBootstrapLimits({})).toEqual({
      maxPending: 32,
      timeoutMs: 10_000,
    });
    expect(
      resolveTwilioBootstrapLimits({
        TWILIO_VOICE_MAX_PENDING_BOOTSTRAPS: "0",
      }),
    ).toBeNull();
    expect(
      resolveTwilioBootstrapLimits({
        TWILIO_VOICE_BOOTSTRAP_TIMEOUT_MS: "not-a-number",
      }),
    ).toBeNull();
    expect(
      resolveTwilioBootstrapLimits({
        TWILIO_VOICE_MAX_PENDING_BOOTSTRAPS: "257",
      }),
    ).toBeNull();
    expect(
      resolveTwilioBootstrapLimits({
        TWILIO_VOICE_BOOTSTRAP_TIMEOUT_MS: "60001",
      }),
    ).toBeNull();
  });

  test("does not continue an async bootstrap phase after the socket closes", async () => {
    let resolvePhase!: (value: string) => void;
    const phase = new Promise<string>((resolve) => {
      resolvePhase = resolve;
    });
    let closed = false;
    const resultPromise = awaitTwilioBootstrapPhase(phase, () => closed);

    closed = true;
    resolvePhase("verified");

    expect(await resultPromise).toEqual({ status: "closed" });
  });
});
