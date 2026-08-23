/**
 * Unit coverage for the shell-access permission prober. Drives the real
 * `shellProber` so check() and request() always-granted behaviour, lastRequested
 * stamping, ignored caller reason, omitted optional fields, and stateless
 * check-after-request are asserted against live `buildState` output. There is
 * no OS collaborator to stub: shell execution is app-internal and this prober
 * has no platform, queue, capacity, or comparator branches.
 */
import { describe, expect, it } from "vitest";

import { buildState, PLATFORM } from "./_bridge.ts";
import { shellProber } from "./shell.ts";

const CHECK_KEYS = ["canRequest", "id", "lastChecked", "platform", "status"];
const REQUEST_KEYS = [...CHECK_KEYS, "lastRequested"];

function expectGrantedShellState(
  state: Awaited<ReturnType<typeof shellProber.check>>,
  before: number,
  after: number,
): void {
  expect(state.id).toBe("shell");
  expect(state.status).toBe("granted");
  expect(state.canRequest).toBe(false);
  expect(state.platform).toBe(PLATFORM);
  expect(state.platform).toBe(process.platform);
  expect(state.lastChecked).toBeGreaterThanOrEqual(before);
  expect(state.lastChecked).toBeLessThanOrEqual(after);
  expect(state.restrictedReason).toBeUndefined();
  expect(state.lastBlockedFeature).toBeUndefined();
  expect(state.reason).toBeUndefined();
  expect("restrictedReason" in state).toBe(false);
  expect("lastBlockedFeature" in state).toBe(false);
  expect("reason" in state).toBe(false);
}

describe("shellProber", () => {
  it("exports id shell with check/request and no openSettings helper", () => {
    expect(shellProber.id).toBe("shell");
    expect(typeof shellProber.check).toBe("function");
    expect(typeof shellProber.request).toBe("function");
    expect(shellProber.openSettings).toBeUndefined();
  });
});

describe("shellProber.check", () => {
  it("reports granted and unrequestable without lastRequested", async () => {
    const before = Date.now();
    const state = await shellProber.check();
    const after = Date.now();
    expectGrantedShellState(state, before, after);
    expect(state.lastRequested).toBeUndefined();
    expect("lastRequested" in state).toBe(false);
    expect(Object.keys(state).sort()).toEqual([...CHECK_KEYS].sort());
  });

  it("matches live buildState except for the timestamp", async () => {
    const state = await shellProber.check();
    const expected = buildState("shell", "granted", { canRequest: false });
    expect(state).toEqual({
      ...expected,
      lastChecked: state.lastChecked,
    });
  });

  it("returns independent snapshots on sequential and concurrent checks", async () => {
    const first = await shellProber.check();
    const second = await shellProber.check();
    expect(first.status).toBe("granted");
    expect(second.status).toBe("granted");
    expect(second.lastChecked).toBeGreaterThanOrEqual(first.lastChecked);
    expect("lastRequested" in first).toBe(false);
    expect("lastRequested" in second).toBe(false);

    const [left, right] = await Promise.all([
      shellProber.check(),
      shellProber.check(),
    ]);
    expect(left.status).toBe("granted");
    expect(right.status).toBe("granted");
    expect(left.canRequest).toBe(false);
    expect(right.canRequest).toBe(false);
  });
});

describe("shellProber.request", () => {
  it("reports granted, stamps lastRequested, and ignores the caller reason", async () => {
    const before = Date.now();
    const state = await shellProber.request({
      reason: "distinct-caller-reason",
    });
    const after = Date.now();
    expectGrantedShellState(state, before, after);
    expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeLessThanOrEqual(after);
    expect(state.reason).toBeUndefined();
    expect(Object.keys(state).sort()).toEqual([...REQUEST_KEYS].sort());
  });

  it("matches live buildState including lastRequested", async () => {
    const state = await shellProber.request({ reason: "need a shell" });
    const expected = buildState("shell", "granted", {
      canRequest: false,
      lastRequested: state.lastRequested,
    });
    expect(state).toEqual({
      ...expected,
      lastChecked: state.lastChecked,
    });
  });

  it("still grants when the caller reason is empty", async () => {
    const before = Date.now();
    const state = await shellProber.request({ reason: "" });
    const after = Date.now();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.reason).toBeUndefined();
    expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeLessThanOrEqual(after);
  });

  it("does not retain lastRequested on a later check (stateless)", async () => {
    const requested = await shellProber.request({ reason: "run a command" });
    expect(requested.lastRequested).toEqual(expect.any(Number));
    const checked = await shellProber.check();
    expect("lastRequested" in checked).toBe(false);
    expect(checked.status).toBe("granted");
  });

  it("stamps lastRequested independently on sequential and concurrent requests", async () => {
    const first = await shellProber.request({ reason: "first" });
    const second = await shellProber.request({ reason: "second" });
    const firstRequested = first.lastRequested;
    const secondRequested = second.lastRequested;
    expect(typeof firstRequested).toBe("number");
    expect(typeof secondRequested).toBe("number");
    if (
      typeof firstRequested !== "number" ||
      typeof secondRequested !== "number"
    ) {
      throw new Error("request() must stamp lastRequested");
    }
    expect(secondRequested).toBeGreaterThanOrEqual(firstRequested);

    const [left, right] = await Promise.all([
      shellProber.request({ reason: "left" }),
      shellProber.request({ reason: "right" }),
    ]);
    expect(left.status).toBe("granted");
    expect(right.status).toBe("granted");
    expect(left.lastRequested).toEqual(expect.any(Number));
    expect(right.lastRequested).toEqual(expect.any(Number));
  });
});
