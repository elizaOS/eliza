/**
 * #9939 — the orphan-shared bridge reaper. The safety-critical part is the pure
 * orphan rule: it must reap a leaked shared bridge that a live dedicated twin
 * superseded, and must NEVER reap a deliberately long-lived shared agent, an
 * in-flight handoff, or a bridge whose only "twin" is older / not running /
 * a different agent. Those are exhaustively pinned here without a DB. The
 * orchestration test proves it reaps by id via the shared `deleteAgent`
 * cascade, counts failures without aborting the batch, and no-ops cleanly.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  type DedicatedTwin,
  reapOrphanedSharedBridges,
  type SharedBridgeCandidate,
  selectOrphanedSharedBridges,
} from "./orphan-shared-bridge-reaper";

const NOW = 10_000_000_000;
const MIN_AGE = 30 * 60 * 1000;
const OLD = new Date(NOW - MIN_AGE - 1); // just past the floor
const YOUNG = new Date(NOW - MIN_AGE + 60_000); // still inside the window

function bridge(over: Partial<SharedBridgeCandidate> = {}): SharedBridgeCandidate {
  return {
    id: "bridge-1",
    organization_id: "org-1",
    user_id: "user-1",
    agent_name: "Ada",
    created_at: OLD,
    ...over,
  };
}

function twin(over: Partial<DedicatedTwin> = {}): DedicatedTwin {
  return {
    organization_id: "org-1",
    user_id: "user-1",
    agent_name: "Ada",
    created_at: new Date(OLD.getTime() + 1000), // minted after the bridge
    ...over,
  };
}

describe("selectOrphanedSharedBridges (pure orphan rule)", () => {
  test("reaps a stale shared bridge superseded by a live dedicated twin", () => {
    expect(selectOrphanedSharedBridges([bridge()], [twin()], NOW, MIN_AGE)).toEqual(["bridge-1"]);
  });

  test("does NOT reap a shared bridge with NO dedicated twin (deliberate long-lived shared agent)", () => {
    expect(selectOrphanedSharedBridges([bridge()], [], NOW, MIN_AGE)).toEqual([]);
  });

  test("does NOT reap an in-flight handoff (younger than the floor)", () => {
    expect(
      selectOrphanedSharedBridges(
        [bridge({ created_at: YOUNG })],
        [twin({ created_at: new Date(YOUNG.getTime() + 1000) })],
        NOW,
        MIN_AGE,
      ),
    ).toEqual([]);
  });

  test("does NOT reap when the twin was created BEFORE the bridge (a different pre-existing agent)", () => {
    expect(
      selectOrphanedSharedBridges(
        [bridge()],
        [twin({ created_at: new Date(OLD.getTime() - 1000) })],
        NOW,
        MIN_AGE,
      ),
    ).toEqual([]);
  });

  test("does NOT reap when the only twin has a different agent_name / user / org", () => {
    expect(
      selectOrphanedSharedBridges([bridge()], [twin({ agent_name: "Babbage" })], NOW, MIN_AGE),
    ).toEqual([]);
    expect(
      selectOrphanedSharedBridges([bridge()], [twin({ user_id: "user-2" })], NOW, MIN_AGE),
    ).toEqual([]);
    expect(
      selectOrphanedSharedBridges([bridge()], [twin({ organization_id: "org-2" })], NOW, MIN_AGE),
    ).toEqual([]);
  });

  test("does NOT reap an unnamed bridge even with a matching-null twin (uncorrelatable)", () => {
    expect(
      selectOrphanedSharedBridges(
        [bridge({ agent_name: null })],
        [twin({ agent_name: null })],
        NOW,
        MIN_AGE,
      ),
    ).toEqual([]);
  });
});

describe("reapOrphanedSharedBridges (orchestration)", () => {
  const makeDeps = (
    candidates: SharedBridgeCandidate[],
    twins: DedicatedTwin[],
    deleteImpl: (id: string, org: string) => Promise<unknown>,
  ) => ({
    listCandidates: mock(async () => candidates),
    listTwins: mock(async () => twins),
    deleteAgent: mock(deleteImpl),
    now: () => NOW,
  });

  test("reaps only the orphans, via deleteAgent, and reports counts", async () => {
    const orphan = bridge({ id: "orphan-1" });
    const keep = bridge({ id: "keep-1", agent_name: "Lovelace" }); // no twin
    const deps = makeDeps([orphan, keep], [twin()], async () => undefined);

    const result = await reapOrphanedSharedBridges({}, deps);

    expect(result).toEqual({ scanned: 2, reaped: 1, reapFailed: 0 });
    expect(deps.deleteAgent).toHaveBeenCalledTimes(1);
    expect(deps.deleteAgent).toHaveBeenCalledWith("orphan-1", "org-1");
  });

  test("a delete failure is counted, not thrown, and does not abort the batch", async () => {
    const a = bridge({ id: "a" });
    const b = bridge({ id: "b" });
    const deps = makeDeps([a, b], [twin()], async (id) => {
      if (id === "a") throw new Error("node unreachable");
      return undefined;
    });

    const result = await reapOrphanedSharedBridges({}, deps);

    expect(result).toEqual({ scanned: 2, reaped: 1, reapFailed: 1 });
    expect(deps.deleteAgent).toHaveBeenCalledTimes(2);
  });

  test("no candidates → no twin lookup, no deletes", async () => {
    const deps = makeDeps([], [], async () => undefined);
    const result = await reapOrphanedSharedBridges({}, deps);
    expect(result).toEqual({ scanned: 0, reaped: 0, reapFailed: 0 });
    expect(deps.listTwins).not.toHaveBeenCalled();
    expect(deps.deleteAgent).not.toHaveBeenCalled();
  });

  test("caps `max` at 50 even when a larger value is requested", async () => {
    const deps = makeDeps([], [], async () => undefined);
    await reapOrphanedSharedBridges({ max: 10_000 }, deps);
    expect(deps.listCandidates).toHaveBeenCalledWith(expect.any(Date), 50);
  });
});
