/**
 * Exercises the real pure dossier admission policy across owner days, control
 * transitions and persisted-state reload. SQL concurrency is tested by the spine.
 */
import { describe, expect, it } from "vitest";
import {
  admitDossierActivity,
  consumeDossierActivity,
  type DossierActivityState,
  type DossierActivityTask,
  dossierOwnerDay,
  isManagedDossierTask,
  DOSSIER_ACTIVITY_METADATA_KEY as KEY,
  readDossierActivityState,
  resolveDossierActivityAnchor,
  type TrustedDossierActivity,
  updateDossierActivityControl,
} from "./dossier-activity-policy.js";

const day = { timezone: "America/Los_Angeles", boundaryMinutes: 240 };
const nowIso = "2026-09-19T12:00:00.000Z";
function task(state?: DossierActivityState): DossierActivityTask {
  return {
    source: "first_run",
    idempotencyKey: "lifeops:first-run:default:morning-brief",
    trigger: {
      kind: "relative_to_anchor",
      anchorKey: "dossier.owner_activity",
      offsetMinutes: 0,
    },
    state: { status: "scheduled", followupCount: 0 },
    metadata: state ? { [KEY]: state } : {},
  };
}
function initial(): DossierActivityState {
  const state = updateDossierActivityControl({
    previous: null,
    next: task(),
    nowIso,
    day,
  });
  if (!state) throw new Error("Expected managed state");
  return state;
}
function event(
  overrides: Partial<TrustedDossierActivity> = {},
): TrustedDossierActivity {
  return {
    authenticated: true,
    principalId: "owner",
    ownerPrincipalId: "owner",
    receivedAtIso: "2026-09-19T12:01:00.000Z",
    signalId: "device-a-event",
    kind: "foreground",
    ...overrides,
  };
}
function control(
  state: DossierActivityState,
  disabled: boolean,
): DossierActivityState {
  const previous = task(state);
  previous.trigger = state.enabled ? task().trigger : { kind: "manual" };
  const next = {
    ...previous,
    trigger: disabled ? { kind: "manual" as const } : task().trigger,
  };
  const result = updateDossierActivityControl({
    previous,
    next,
    nowIso: disabled ? "2026-09-19T12:02:00.000Z" : "2026-09-19T12:03:00.000Z",
    day,
  });
  if (!result) throw new Error("Expected managed state");
  return result;
}

describe("managed dossier activity admission", () => {
  it("recognizes stable managed identities and excludes lookalikes", () => {
    expect(isManagedDossierTask(task())).toBe(true);
    expect(
      isManagedDossierTask({
        ...task(),
        source: "default_pack",
        idempotencyKey: "default-pack:morning-brief:assembler",
      }),
    ).toBe(true);
    expect(isManagedDossierTask({ ...task(), source: "user_chat" })).toBe(
      false,
    );
    expect(
      isManagedDossierTask({ ...task(), idempotencyKey: "morning-brief" }),
    ).toBe(false);
  });

  it("uses the configured civil boundary across DST and year rollover", () => {
    expect(dossierOwnerDay("2026-03-08T10:59:00Z", day)).toBe("2026-03-07");
    expect(dossierOwnerDay("2026-03-08T11:00:00Z", day)).toBe("2026-03-08");
    expect(dossierOwnerDay("2026-11-01T09:30:00Z", day)).toBe("2026-10-31");
    expect(dossierOwnerDay("2027-01-01T09:00:00Z", day)).toBe("2026-12-31");
    expect(() =>
      dossierOwnerDay(nowIso, { ...day, timezone: "not/a-zone" }),
    ).toThrow();
    expect(() =>
      dossierOwnerDay(nowIso, { ...day, boundaryMinutes: 1440 }),
    ).toThrow();
  });

  it("does not admit nonowner, unauthenticated, inactive or disabled activity", () => {
    const state = initial();
    for (const input of [
      event({ authenticated: false }),
      event({ principalId: "admin" }),
      event({ kind: "other" }),
      event({ principalId: "" }),
    ]) {
      expect(admitDossierActivity(state, input)).toBe(state);
    }
    const disabled = control(state, true);
    expect(admitDossierActivity(disabled, event())).toBe(disabled);
    expect(resolveDossierActivityAnchor(state, nowIso)).toBeNull();
  });

  it("fixes the first admitted timestamp across devices and restart", () => {
    const first = admitDossierActivity(initial(), event());
    const restarted = readDossierActivityState(
      JSON.parse(JSON.stringify({ [KEY]: first })),
    );
    expect(restarted).toEqual(first);
    if (!restarted) throw new Error("Expected persisted state");
    expect(
      admitDossierActivity(
        restarted,
        event({
          signalId: "device-b",
          kind: "unlock",
          receivedAtIso: "2026-09-19T18:00:00Z",
        }),
      ),
    ).toBe(restarted);
    expect(
      resolveDossierActivityAnchor(restarted, "2026-09-19T18:00:00Z"),
    ).toBe(event().receivedAtIso);
    expect(resolveDossierActivityAnchor(restarted, nowIso)).toBeNull();
    expect(
      resolveDossierActivityAnchor(restarted, "2026-09-20T12:00:00Z"),
    ).toBeNull();
  });

  it("requires fresh activity after reenable while retaining consumed days", () => {
    const admitted = admitDossierActivity(initial(), event());
    const enabled = control(control(admitted, true), false);
    expect(enabled.generation).toBe(3);
    expect(enabled.admitted).toBeNull();
    expect(admitDossierActivity(enabled, event())).toBe(enabled);
    const fresh = admitDossierActivity(
      enabled,
      event({ receivedAtIso: "2026-09-19T12:04:00Z" }),
    );
    const consumed = consumeDossierActivity(fresh, "2026-09-19T12:05:00Z");
    const toggled = control(control(consumed, true), false);
    expect(
      admitDossierActivity(
        toggled,
        event({ receivedAtIso: "2026-09-19T18:00:00Z" }),
      ),
    ).toBe(toggled);
    expect(
      admitDossierActivity(
        toggled,
        event({ receivedAtIso: "2026-09-20T12:00:00Z" }),
      ).admitted?.dayKey,
    ).toBe("2026-09-20");
    expect(() =>
      consumeDossierActivity(consumed, "2026-09-19T18:00:00Z"),
    ).toThrow();
  });

  it("clears pending admission on dismiss, reopen and scheduling changes", () => {
    const admitted = admitDossierActivity(initial(), event());
    const previous = task(admitted);
    const dismissed = {
      ...previous,
      state: { ...previous.state, status: "dismissed" as const },
    };
    const off = updateDossierActivityControl({
      previous,
      next: dismissed,
      nowIso,
      day,
    });
    expect(off?.enabled).toBe(false);
    expect(off?.admitted).toBeNull();
    const reopened = updateDossierActivityControl({
      previous: { ...dismissed, metadata: { [KEY]: off } },
      next: task(),
      nowIso,
      day,
    });
    expect(reopened?.generation).toBe(3);
    expect(reopened?.admitted).toBeNull();
    expect(
      updateDossierActivityControl({ previous, next: previous, nowIso, day }),
    ).toEqual(admitted);
    expect(
      updateDossierActivityControl({
        previous,
        next: previous,
        nowIso,
        day: { ...day, boundaryMinutes: 300 },
      })?.admitted,
    ).toBeNull();
  });

  it("retains the admitted occurrence when an equivalent trigger has reordered keys", () => {
    const admitted = admitDossierActivity(initial(), event());
    const previous = task(admitted);
    const next = {
      ...previous,
      trigger: {
        offsetMinutes: 0,
        anchorKey: "dossier.owner_activity",
        kind: "relative_to_anchor" as const,
      },
    };
    const updated = updateDossierActivityControl({
      previous,
      next,
      nowIso: "2026-09-19T12:03:00Z",
      day,
    });
    expect(updated).toEqual(admitted);
    if (!updated) throw new Error("Expected managed state");
    expect(resolveDossierActivityAnchor(updated, "2026-09-19T12:04:00Z")).toBe(
      event().receivedAtIso,
    );
  });

  it.each(["completed", "failed", "skipped", "expired"] as const)(
    "requires new activity after reopening a %s task and retains an already-consumed day",
    (status) => {
      const admitted = admitDossierActivity(initial(), event());
      for (const prior of [
        admitted,
        consumeDossierActivity(admitted, "2026-09-19T12:02:00Z"),
      ]) {
        const previous = {
          ...task(prior),
          state: { status, followupCount: 0 },
        };
        const updated = updateDossierActivityControl({
          previous,
          next: task(prior),
          nowIso: "2026-09-19T12:03:00Z",
          day,
        });
        expect(updated?.generation).toBe(prior.generation + 1);
        expect(updated?.admitted).toBeNull();
        expect(updated?.consumedDay).toBe(prior.consumedDay);
        if (!updated) throw new Error("Expected managed state");
        expect(admitDossierActivity(updated, event())).toBe(updated);
        const fresh = admitDossierActivity(
          updated,
          event({ receivedAtIso: "2026-09-19T12:04:00Z" }),
        );
        if (prior.consumedDay) expect(fresh).toBe(updated);
        else
          expect(
            resolveDossierActivityAnchor(fresh, "2026-09-19T12:05:00Z"),
          ).toBe("2026-09-19T12:04:00Z");
      }
    },
  );

  it("rejects malformed persisted admission and invalid activity timestamps", () => {
    const state = initial();
    expect(readDossierActivityState({})).toBeNull();
    for (const bad of [
      null,
      {},
      { ...state, generation: 0 },
      { ...state, unexpected: true },
      {
        ...state,
        enabled: false,
        admitted: admitDossierActivity(state, event()).admitted,
      },
    ]) {
      expect(() => readDossierActivityState({ [KEY]: bad })).toThrow();
    }
    expect(() =>
      admitDossierActivity(state, event({ receivedAtIso: "yesterday" })),
    ).toThrow();
  });
});
