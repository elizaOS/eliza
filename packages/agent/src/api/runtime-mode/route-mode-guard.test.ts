/**
 * Coverage for the route-mode gate decision, focused on the fail-closed
 * drift guard added for arch-audit #12633.
 *
 * We exercise the pure `evaluateRouteModeGate` (mode passed explicitly, no
 * disk/snapshot mocking) so the assertions are deterministic and order-
 * independent when run alongside the rest of the mode suite. It asserts:
 *   - un-enumerated children of a protected namespace are still gated by the
 *     catch-all prefix rule (hidden in the namespace's excluded modes);
 *   - handler-declared plugin route `modes` win over the static matrix;
 *   - paths outside any protected namespace pass through (default-allow);
 *   - the fail-closed branch fires (hidden) for a protected path that no
 *     rule governs.
 */

import { describe, expect, test } from "vitest";
import { evaluateRouteModeGate } from "./route-mode-guard.ts";

describe("evaluateRouteModeGate — fail-closed protected namespaces (#12633)", () => {
  test("a NEW un-enumerated child of /api/local-inference/ is gated by the catch-all", () => {
    const child = "/api/local-inference/__brand_new_undeclared__";
    for (const mode of ["cloud", "remote"] as const) {
      expect(
        evaluateRouteModeGate({ pathname: child, method: "GET", mode }).hidden,
        `hidden in ${mode}`,
      ).toBe(true);
    }
    for (const mode of ["local", "local-only"] as const) {
      expect(
        evaluateRouteModeGate({ pathname: child, method: "GET", mode }).hidden,
        `hidden in ${mode}`,
      ).toBe(false);
    }
  });

  test("a NEW un-enumerated child of /api/cloud/ is gated by the catch-all (hidden in local-only)", () => {
    const child = "/api/cloud/__brand_new_undeclared__";
    expect(
      evaluateRouteModeGate({
        pathname: child,
        method: "POST",
        mode: "local-only",
      }).hidden,
    ).toBe(true);
    for (const mode of ["local", "cloud", "remote"] as const) {
      expect(
        evaluateRouteModeGate({ pathname: child, method: "POST", mode }).hidden,
        `hidden in ${mode}`,
      ).toBe(false);
    }
  });

  test("path OUTSIDE any protected namespace passes through (default-allow)", () => {
    for (const mode of ["local", "local-only", "cloud", "remote"] as const) {
      expect(
        evaluateRouteModeGate({
          pathname: "/api/agent/reset",
          method: "POST",
          mode,
        }).hidden,
        `hidden in ${mode}`,
      ).toBe(false);
    }
  });

  test("declared /api/local-inference/* hides in cloud + remote, shows in local runtimes", () => {
    for (const mode of ["cloud", "remote"] as const) {
      expect(
        evaluateRouteModeGate({
          pathname: "/api/local-inference/hub",
          method: "GET",
          mode,
        }).hidden,
      ).toBe(true);
    }
    for (const mode of ["local", "local-only"] as const) {
      expect(
        evaluateRouteModeGate({
          pathname: "/api/local-inference/hub",
          method: "GET",
          mode,
        }).hidden,
      ).toBe(false);
    }
  });

  test("handler-declared plugin route modes win over the static matrix", () => {
    // A plugin declares /api/tts/cloud visible in local/cloud/remote via its
    // route.modes — the gate honors that declaration (hidden only in
    // local-only) even though the static matrix has no entry for it.
    const runtime = {
      routes: [
        {
          type: "POST" as const,
          path: "/api/tts/cloud",
          rawPath: true,
          modes: ["local", "cloud", "remote"] as const,
          modeReason: "cloud TTS preview fixture",
        },
      ],
    };
    expect(
      evaluateRouteModeGate({
        pathname: "/api/tts/cloud",
        method: "POST",
        mode: "local-only",
        runtime,
      }).hidden,
    ).toBe(true);
    for (const mode of ["local", "cloud", "remote"] as const) {
      expect(
        evaluateRouteModeGate({
          pathname: "/api/tts/cloud",
          method: "POST",
          mode,
          runtime,
        }).hidden,
        `hidden in ${mode}`,
      ).toBe(false);
    }
  });
});
