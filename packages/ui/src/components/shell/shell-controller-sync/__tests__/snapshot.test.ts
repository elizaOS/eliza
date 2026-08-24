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

describe("deriveShellControllerSnapshot optional fields", () => {
  it("passes through the optional surface scalars when set", () => {
    const controller = makeFakeShellController();
    controller.currentTab = "/chat";
    controller.conversationLoading = true;
    controller.noProviderConfigured = false;
    controller.bootProgressSignal = "dl:42";
    const snap = deriveShellControllerSnapshot(controller);
    expect(snap.currentTab).toBe("/chat");
    expect(snap.conversationLoading).toBe(true);
    expect(snap.noProviderConfigured).toBe(false);
    expect(snap.bootProgressSignal).toBe("dl:42");
  });

  it("projects only conversationNav data and drops the imperative methods", () => {
    const controller = makeFakeShellController();
    controller.conversationNav.hasPrev = true;
    controller.conversationNav.hasNext = true;
    controller.conversationNav.activeId = "c1";
    controller.conversationNav.index = 3;
    const snap = deriveShellControllerSnapshot(controller);
    expect(snap.conversationNav).toEqual({
      hasPrev: true,
      hasNext: true,
      activeId: "c1",
      index: 3,
    });
    expect("goPrev" in snap.conversationNav).toBe(false);
    expect("goNext" in snap.conversationNav).toBe(false);
  });

  it("preserves the messages array reference for coalescing", () => {
    const controller = makeFakeShellController();
    const msgs: ShellMessage[] = [
      { id: "1", role: "user", content: "a", createdAt: 1 },
    ];
    controller.messages = msgs;
    expect(deriveShellControllerSnapshot(controller).messages).toBe(msgs);
  });
});

describe("parseShellControllerSnapshot rejections", () => {
  /** A wire-shaped record with typed fixture defaults overridden by raw
   *  (possibly invalid) values, so invalid payloads need no casts. */
  const wire = (over: Record<string, unknown> = {}) => ({
    ...baseSnapshot(),
    ...over,
  });
  const message = { id: "m", role: "user", content: "", createdAt: 0 };

  it("rejects non-record inputs including arrays", () => {
    expect(parseShellControllerSnapshot(null)).toBeNull();
    expect(parseShellControllerSnapshot(undefined)).toBeNull();
    expect(parseShellControllerSnapshot(42)).toBeNull();
    expect(parseShellControllerSnapshot("snapshot")).toBeNull();
    expect(parseShellControllerSnapshot(true)).toBeNull();
    expect(parseShellControllerSnapshot([])).toBeNull();
  });

  it("rejects an invalid or missing phase", () => {
    expect(parseShellControllerSnapshot(wire({ phase: "quantum" }))).toBeNull();
    const missingPhase: Record<string, unknown> = wire();
    delete missingPhase.phase;
    expect(parseShellControllerSnapshot(missingPhase)).toBeNull();
  });

  it("enforces the gated/phase pairing invariant on authGate", () => {
    expect(
      parseShellControllerSnapshot(
        wire({ authGate: { gated: true, phase: "clear" } }),
      ),
    ).toBeNull();
    expect(
      parseShellControllerSnapshot(
        wire({ authGate: { gated: false, phase: "needs-auth" } }),
      ),
    ).toBeNull();
    const parsed = parseShellControllerSnapshot(
      wire({ authGate: { gated: true, phase: "needs-auth" } }),
    );
    expect(parsed?.authGate).toEqual({ gated: true, phase: "needs-auth" });
  });

  it("accepts a record turnStatus and rejects other non-null values", () => {
    const turn = { kind: "thinking" };
    expect(
      parseShellControllerSnapshot(wire({ turnStatus: turn }))?.turnStatus,
    ).toEqual(turn);
    expect(
      parseShellControllerSnapshot(wire({ turnStatus: "thinking" })),
    ).toBeNull();
  });

  it("accepts exactly 10_000 messages and rejects more", () => {
    const full = wire({
      messages: Array.from({ length: 10_000 }, () => message),
    });
    expect(parseShellControllerSnapshot(full)).not.toBeNull();
    const overflow = wire({
      messages: Array.from({ length: 10_001 }, () => message),
    });
    expect(parseShellControllerSnapshot(overflow)).toBeNull();
  });

  it("rejects malformed message elements", () => {
    expect(
      parseShellControllerSnapshot(
        wire({ messages: [{ role: "user", content: "x", createdAt: 0 }] }),
      ),
    ).toBeNull();
    expect(
      parseShellControllerSnapshot(
        wire({
          messages: [{ id: "", role: "user", content: "x", createdAt: 0 }],
        }),
      ),
    ).toBeNull();
    expect(
      parseShellControllerSnapshot(
        wire({
          messages: [{ id: "1", role: "system", content: "x", createdAt: 0 }],
        }),
      ),
    ).toBeNull();
    expect(
      parseShellControllerSnapshot(
        wire({
          messages: [{ id: "1", role: "user", content: 5, createdAt: 0 }],
        }),
      ),
    ).toBeNull();
    expect(
      parseShellControllerSnapshot(
        wire({ messages: [{ id: "1", role: "user", content: "x" }] }),
      ),
    ).toBeNull();
    expect(
      parseShellControllerSnapshot(
        wire({
          messages: [
            { id: "1", role: "user", content: "x", createdAt: Number.NaN },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseShellControllerSnapshot(
        wire({
          messages: [
            {
              id: "1",
              role: "user",
              content: "x",
              createdAt: Number.POSITIVE_INFINITY,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("validates modelStatus shape", () => {
    expect(
      parseShellControllerSnapshot(wire({ modelStatus: null })),
    ).toBeNull();
    expect(
      parseShellControllerSnapshot(
        wire({ modelStatus: { blocksSend: false } }),
      ),
    ).toBeNull();
    expect(
      parseShellControllerSnapshot(
        wire({ modelStatus: { kind: 7, blocksSend: false } }),
      ),
    ).toBeNull();
  });

  it("validates waveformMode, micPermission and nav fields", () => {
    expect(
      parseShellControllerSnapshot(wire({ waveformMode: "paused" })),
    ).toBeNull();
    expect(
      parseShellControllerSnapshot(wire({ micPermission: "maybe" })),
    ).toBeNull();
    expect(
      parseShellControllerSnapshot(wire({ micPermission: "unknown" }))
        ?.micPermission,
    ).toBe("unknown");
    expect(
      parseShellControllerSnapshot(
        wire({
          conversationNav: {
            hasPrev: true,
            hasNext: false,
            activeId: null,
            index: 1.5,
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseShellControllerSnapshot(
        wire({
          conversationNav: {
            hasPrev: true,
            hasNext: false,
            activeId: 9,
            index: 0,
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("parseShellControllerSnapshot roundtrip", () => {
  it("accepts a freshly derived snapshot unchanged", () => {
    const controller = makeFakeShellController();
    controller.recording = true;
    controller.transcript = "hello";
    controller.currentTab = "/settings";
    const snap = deriveShellControllerSnapshot(controller);
    const parsed = parseShellControllerSnapshot(snap);
    expect(parsed).not.toBeNull();
    expect(parsed?.recording).toBe(true);
    expect(parsed?.transcript).toBe("hello");
    expect(parsed?.currentTab).toBe("/settings");
    expect(parsed?.conversationNav.index).toBe(-1);
  });
});

describe("snapshotsEqual model-status comparison", () => {
  it("compares modelStatus structurally across fresh object references", () => {
    const errors: string[] = [];
    const downloading = () => ({
      kind: "downloading" as const,
      blocksSend: true,
      percent: 42,
      etaMs: 1200,
      modelName: "llama",
      modelId: "m1",
      errors,
    });
    expect(
      snapshotsEqual(
        baseSnapshot({ modelStatus: downloading() }),
        baseSnapshot({ modelStatus: downloading() }),
      ),
    ).toBe(true);
    expect(
      snapshotsEqual(
        baseSnapshot({ modelStatus: downloading() }),
        baseSnapshot({ modelStatus: { ...downloading(), percent: 43 } }),
      ),
    ).toBe(false);
    expect(
      snapshotsEqual(
        baseSnapshot({ modelStatus: downloading() }),
        baseSnapshot({ modelStatus: { ...downloading(), errors: [] } }),
      ),
    ).toBe(false);
  });

  it("compares modelStatus.errors by reference", () => {
    const errors = ["boom"];
    const status = () => ({
      kind: "error" as const,
      blocksSend: true,
      percent: null,
      etaMs: null,
      modelName: null,
      errors,
    });
    const copied = () => ({ ...status(), errors: [...errors] });
    expect(
      snapshotsEqual(
        baseSnapshot({ modelStatus: status() }),
        baseSnapshot({ modelStatus: status() }),
      ),
    ).toBe(true);
    expect(
      snapshotsEqual(
        baseSnapshot({ modelStatus: status() }),
        baseSnapshot({ modelStatus: copied() }),
      ),
    ).toBe(false);
  });
});

describe("snapshotsEqual remaining render-relevant fields", () => {
  it("detects changes in the remaining scalar surface", () => {
    expect(
      snapshotsEqual(baseSnapshot(), baseSnapshot({ canSend: false })),
    ).toBe(false);
    expect(
      snapshotsEqual(baseSnapshot(), baseSnapshot({ transcript: "hi" })),
    ).toBe(false);
    expect(
      snapshotsEqual(
        baseSnapshot(),
        baseSnapshot({ waveformMode: "listening" }),
      ),
    ).toBe(false);
    expect(
      snapshotsEqual(baseSnapshot(), baseSnapshot({ micPermission: "denied" })),
    ).toBe(false);
    expect(
      snapshotsEqual(baseSnapshot(), baseSnapshot({ speaking: true })),
    ).toBe(false);
    expect(snapshotsEqual(baseSnapshot(), baseSnapshot({ isOpen: true }))).toBe(
      false,
    );
  });

  it("detects changes in the optional surface scalars", () => {
    expect(
      snapshotsEqual(baseSnapshot(), baseSnapshot({ currentTab: "/chat" })),
    ).toBe(false);
    expect(
      snapshotsEqual(
        baseSnapshot(),
        baseSnapshot({ bootProgressSignal: "dl:1" }),
      ),
    ).toBe(false);
    expect(
      snapshotsEqual(
        baseSnapshot({ conversationLoading: true }),
        baseSnapshot(),
      ),
    ).toBe(false);
    expect(
      snapshotsEqual(
        baseSnapshot(),
        baseSnapshot({ noProviderConfigured: true }),
      ),
    ).toBe(false);
  });

  it("compares authGate by gated and phase", () => {
    expect(
      snapshotsEqual(
        baseSnapshot(),
        baseSnapshot({
          authGate: { gated: true, phase: "needs-auth" },
          canSend: false,
        }),
      ),
    ).toBe(false);
  });

  it("compares turnStatus by reference", () => {
    const turn = { kind: "speaking" as const };
    expect(
      snapshotsEqual(
        baseSnapshot({ turnStatus: turn }),
        baseSnapshot({ turnStatus: turn }),
      ),
    ).toBe(true);
    expect(
      snapshotsEqual(
        baseSnapshot({ turnStatus: turn }),
        baseSnapshot({ turnStatus: { ...turn } }),
      ),
    ).toBe(false);
  });
});
