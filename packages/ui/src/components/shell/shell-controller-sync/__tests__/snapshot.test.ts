/** Snapshot projection + coalescing equality. */
import { describe, expect, it } from "vitest";
import type { ShellMessage } from "../../shell-state";
import {
  deriveShellControllerSnapshot,
  parseShellControllerSnapshot,
  snapshotsEqual,
} from "../snapshot";
import { baseSnapshot, makeFakeShellController } from "./fixtures";

describe("deriveShellControllerSnapshot", () => {
  it("projects read fields and drops the non-serialisable analyser", () => {
    const controller = makeFakeShellController();
    controller.recording = true;
    controller.transcript = "hi";
    controller.authGate = { gated: true, phase: "needs-auth" };
    controller.signingIn = true;
    const snap = deriveShellControllerSnapshot(controller);
    expect(snap.recording).toBe(true);
    expect(snap.transcript).toBe("hi");
    expect(snap.authGate).toEqual({ gated: true, phase: "needs-auth" });
    expect(snap.signingIn).toBe(true);
    expect("analyser" in snap).toBe(false);
    expect(snap.conversationNav).toEqual({
      hasPrev: false,
      hasNext: false,
      activeId: null,
      index: -1,
    });
  });
});

describe("parseShellControllerSnapshot", () => {
  it("accepts the unavailable auth-recovery phase across desktop windows", () => {
    const snapshot = baseSnapshot({
      authGate: { gated: true, phase: "unavailable" },
    });
    expect(parseShellControllerSnapshot(snapshot)?.authGate).toEqual({
      gated: true,
      phase: "unavailable",
    });
  });
});

describe("snapshotsEqual", () => {
  it("is true for equal snapshots and false when a scalar changes", () => {
    expect(snapshotsEqual(baseSnapshot(), baseSnapshot())).toBe(true);
    expect(
      snapshotsEqual(baseSnapshot(), baseSnapshot({ recording: true })),
    ).toBe(false);
    expect(
      snapshotsEqual(baseSnapshot(), baseSnapshot({ signingIn: true })),
    ).toBe(false);
  });
  it("compares messages by reference (identity-preserving projection)", () => {
    const msgs: ShellMessage[] = [
      { id: "1", role: "user", content: "a", createdAt: 1 },
    ];
    expect(
      snapshotsEqual(
        baseSnapshot({ messages: msgs }),
        baseSnapshot({ messages: msgs }),
      ),
    ).toBe(true);
    expect(
      snapshotsEqual(
        baseSnapshot({ messages: msgs }),
        baseSnapshot({ messages: [...msgs] }),
      ),
    ).toBe(false);
  });
  it("detects a nav change", () => {
    expect(
      snapshotsEqual(
        baseSnapshot(),
        baseSnapshot({
          conversationNav: {
            hasPrev: true,
            hasNext: false,
            activeId: "c",
            index: 0,
          },
        }),
      ),
    ).toBe(false);
  });
});
