/** Verifies the cloud-only pill auth-gate matrix through the package harness. */
// Pure deriveShellAuthGate + deriveShellPhase decisions. No React, no network.

import { describe, expect, it } from "vitest";
import type { AuthStatusState } from "../../../hooks/useAuthStatus";
import {
  deriveShellAuthGate,
  deriveShellPhase,
  type ShellAuthGatePhase,
} from "../shell-auth-gate";
import type { ShellPhase } from "../shell-state";

const AUTH_PHASES: AuthStatusState["phase"][] = [
  "loading",
  "authenticated",
  "unauthenticated",
  "server_unavailable",
];

describe("deriveShellAuthGate", () => {
  it("never gates a non-cloud-only build, including a local owner-key session", () => {
    for (const authPhase of AUTH_PHASES) {
      expect(
        deriveShellAuthGate({
          cloudOnly: false,
          authPhase,
          hasUsableCloudSession: false,
        }),
      ).toEqual({
        gated: false,
        phase: "clear",
      });
    }
  });

  it("treats cloud-only authenticated as clear", () => {
    expect(
      deriveShellAuthGate({
        cloudOnly: true,
        authPhase: "authenticated",
        hasUsableCloudSession: true,
      }),
    ).toEqual({ gated: false, phase: "clear" });
  });

  it("treats cloud-only unauthenticated as needs-auth", () => {
    expect(
      deriveShellAuthGate({
        cloudOnly: true,
        authPhase: "unauthenticated",
        hasUsableCloudSession: false,
      }),
    ).toEqual({ gated: true, phase: "needs-auth" });
  });

  it.each(["loading", "authenticated", "server_unavailable"] as const)(
    "requires sign-in without a stored Cloud session while auth is %s",
    (authPhase) => {
      expect(
        deriveShellAuthGate({
          cloudOnly: true,
          authPhase,
          hasUsableCloudSession: false,
        }),
      ).toEqual({ gated: true, phase: "needs-auth" });
    },
  );

  it("keeps loading on checking when a Cloud session exists", () => {
    expect(
      deriveShellAuthGate({
        cloudOnly: true,
        authPhase: "loading",
        hasUsableCloudSession: true,
      }),
    ).toEqual({ gated: true, phase: "checking" });
  });

  it("surfaces server_unavailable distinctly when a Cloud session exists", () => {
    expect(
      deriveShellAuthGate({
        cloudOnly: true,
        authPhase: "server_unavailable",
        hasUsableCloudSession: true,
      }),
    ).toEqual({ gated: true, phase: "unavailable" });
  });
});

describe("deriveShellPhase", () => {
  const idleInputs = {
    ready: true,
    recording: false,
    realtimeVoiceListening: false,
    sttPending: false,
    responding: false,
    isOpen: false,
    authGate: "clear" as ShellAuthGatePhase,
  };

  it("keeps checking on booting even when the agent proxy is up", () => {
    expect(
      deriveShellPhase({ ...idleInputs, ready: true, authGate: "checking" }),
    ).toBe("booting");
  });

  it("keeps unavailable on booting until chat is opened", () => {
    expect(deriveShellPhase({ ...idleInputs, authGate: "unavailable" })).toBe(
      "booting",
    );
    expect(
      deriveShellPhase({
        ...idleInputs,
        authGate: "unavailable",
        isOpen: true,
      }),
    ).toBe("summoned");
  });

  it("surfaces needs-auth even before the agent proxy is up", () => {
    expect(
      deriveShellPhase({
        ...idleInputs,
        ready: false,
        authGate: "needs-auth",
      }),
    ).toBe("needs-auth");
  });

  it("surfaces needs-auth above listening and summon once the proxy is up", () => {
    expect(
      deriveShellPhase({
        ...idleInputs,
        authGate: "needs-auth",
        recording: true,
        isOpen: true,
      }),
    ).toBe("needs-auth");
  });

  it("keeps an already-open overlay summoned while the probe is still checking", () => {
    expect(
      deriveShellPhase({
        ...idleInputs,
        ready: false,
        isOpen: true,
        authGate: "checking",
      }),
    ).toBe("summoned");
  });

  it("preserves the existing waterfall when the gate is clear", () => {
    const cases: Array<[Partial<typeof idleInputs>, ShellPhase]> = [
      [{ ready: false }, "booting"],
      [{ recording: true }, "listening"],
      [{ realtimeVoiceListening: true }, "listening"],
      [{ sttPending: true }, "processing"],
      [{ responding: true }, "responding"],
      [{ isOpen: true }, "summoned"],
      [{}, "idle"],
    ];
    for (const [override, expected] of cases) {
      expect(deriveShellPhase({ ...idleInputs, ...override })).toBe(expected);
    }
  });
});
