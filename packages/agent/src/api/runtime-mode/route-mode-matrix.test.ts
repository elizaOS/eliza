/**
 * Unit coverage for runtime-mode resolution and the route-visibility matrix.
 * `resolveRuntimeMode` maps deployment config to local / local-only / cloud /
 * remote (accepting only private remote targets), and `isRouteVisible` /
 * `findRouteModeRule` / `findRegisteredRouteModeRule` decide which API routes are
 * exposed per mode: local-inference routes hidden off local runtimes, `/api/cloud`
 * hidden in local-only, plugin-declared route modes honored, un-matrixed
 * routes inside an owner-declared protected namespace FAIL CLOSED, and
 * un-matrixed routes outside any protected namespace default-allow
 * (arch-audit #12633).
 */
import { describe, expect, test } from "vitest";
import { findRegisteredRouteModeRule } from "./route-mode-guard.ts";
import {
  assertMatrixReconciled,
  findProtectedNamespace,
  findRouteModeRule,
  isRouteVisible,
  isRouteVisibleWith,
  PROTECTED_MODE_NAMESPACES,
  ROUTE_MODE_MATRIX,
} from "./route-mode-matrix.ts";
import { resolveRuntimeMode, validateRemoteApiBase } from "./runtime-mode.ts";

describe("resolveRuntimeMode", () => {
  test("defaults to local when no deploymentTarget", () => {
    expect(resolveRuntimeMode({}).mode).toBe("local");
  });

  test("local-only when cloud.enabled === false on a local target", () => {
    const snap = resolveRuntimeMode({
      deploymentTarget: { runtime: "local" },
      cloud: { enabled: false },
    });
    expect(snap.mode).toBe("local-only");
  });

  test("cloud when deploymentTarget.runtime === cloud", () => {
    const snap = resolveRuntimeMode({
      deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
    });
    expect(snap.mode).toBe("cloud");
  });

  test("remote includes only local/private remoteApiBase + token", () => {
    const snap = resolveRuntimeMode({
      deploymentTarget: {
        runtime: "remote",
        remoteApiBase: "http://10.0.0.5:31337",
        remoteAccessToken: "secret",
      },
    });
    expect(snap.mode).toBe("remote");
    expect(snap.remoteApiBase).toBe("http://10.0.0.5:31337/");
    expect(snap.remoteApiBaseError).toBeNull();
    expect(snap.remoteAccessToken).toBe("secret");
  });

  test("remote rejects public/cloud targets", () => {
    const snap = resolveRuntimeMode({
      deploymentTarget: {
        runtime: "remote",
        remoteApiBase: "https://api.elizacloud.example",
      },
    });
    expect(snap.mode).toBe("remote");
    expect(snap.remoteApiBase).toBeNull();
    expect(snap.remoteApiBaseError).toMatch(/private-network|loopback|local/i);
  });

  test("remote target validator accepts loopback, private, and .local hosts", () => {
    for (const base of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://10.1.2.3:3000",
      "http://172.20.1.1:3000",
      "http://192.168.1.10:3000",
      "http://100.64.0.2:3000",
      "http://agent.local:3000",
    ]) {
      expect(validateRemoteApiBase(base).ok, base).toBe(true);
    }
  });

  test("remote target validator rejects public hosts", () => {
    for (const base of [
      "https://api.elizacloud.example",
      "https://huggingface.co",
      "http://8.8.8.8:3000",
    ]) {
      expect(validateRemoteApiBase(base).ok, base).toBe(false);
    }
  });

  test("local stays local when cloud.enabled is unset (cloud is optional, not opt-out)", () => {
    expect(
      resolveRuntimeMode({ deploymentTarget: { runtime: "local" } }).mode,
    ).toBe("local");
  });
});

describe("route-mode matrix", () => {
  test("/api/local-inference/* is hidden in cloud mode", () => {
    expect(
      isRouteVisible({
        pathname: "/api/local-inference/hub",
        method: "GET",
        mode: "cloud",
      }),
    ).toBe(false);
    expect(
      isRouteVisible({
        pathname: "/api/local-inference/hub",
        method: "GET",
        mode: "local",
      }),
    ).toBe(true);
    expect(
      isRouteVisible({
        pathname: "/api/local-inference/hub",
        method: "GET",
        mode: "local-only",
      }),
    ).toBe(true);
  });

  test("/api/local-inference/* is hidden in remote mode (target serves it)", () => {
    expect(
      isRouteVisible({
        pathname: "/api/local-inference/active",
        method: "POST",
        mode: "remote",
      }),
    ).toBe(false);
  });

  test("/api/cloud/* is hidden in local-only mode", () => {
    expect(
      isRouteVisible({
        pathname: "/api/cloud/status",
        method: "GET",
        mode: "local-only",
      }),
    ).toBe(false);
    expect(
      isRouteVisible({
        pathname: "/api/cloud/billing/usage",
        method: "GET",
        mode: "local-only",
      }),
    ).toBe(false);
    expect(
      isRouteVisible({
        pathname: "/api/cloud/login",
        method: "POST",
        mode: "local",
      }),
    ).toBe(true);
  });

  test("/api/tts/cloud visibility is owned by the plugin route declaration", () => {
    expect(findRouteModeRule("/api/tts/cloud", "POST")).toBeNull();
    const rule = findRegisteredRouteModeRule({
      runtime: {
        routes: [
          {
            type: "POST",
            path: "/api/tts/cloud",
            rawPath: true,
            modes: ["local", "cloud", "remote"],
            modeReason: "cloud TTS preview fixture",
          },
        ],
      },
      pathname: "/api/tts/cloud",
      method: "POST",
    });

    expect(rule).toMatchObject({
      path: "/api/tts/cloud",
      method: "POST",
      modes: ["local", "cloud", "remote"],
    });
    expect(rule?.modes.includes("local-only")).toBe(false);
  });

  test("local-inference audio routes are hidden outside local runtimes", () => {
    for (const pathname of [
      "/api/tts/local-inference",
      "/api/asr/local-inference",
    ]) {
      for (const mode of ["local", "local-only"] as const) {
        expect(
          isRouteVisible({
            pathname,
            method: "POST",
            mode,
          }),
        ).toBe(true);
      }

      for (const mode of ["cloud", "remote"] as const) {
        expect(
          isRouteVisible({
            pathname,
            method: "POST",
            mode,
          }),
        ).toBe(false);
      }
    }
  });

  test("findRouteModeRule returns null for un-matrixed routes", () => {
    expect(findRouteModeRule("/api/agent/reset", "POST")).toBeNull();
  });

  test("un-matrixed routes OUTSIDE a protected namespace default-allow", () => {
    // Not mode-sensitive: the matrix is a targeted gate, not a wholesale ACL.
    expect(findProtectedNamespace("/api/agent/reset")).toBeNull();
    for (const mode of ["local", "local-only", "cloud", "remote"] as const) {
      expect(
        isRouteVisible({ pathname: "/api/agent/reset", method: "POST", mode }),
      ).toBe(true);
    }
  });

  test("/api/cloud/v1 thin-client proxy stays visible in remote (controller forwards)", () => {
    expect(
      isRouteVisible({
        pathname: "/api/cloud/v1/agents",
        method: "GET",
        mode: "remote",
      }),
    ).toBe(true);
  });
});

describe("route-mode fail-closed namespaces (arch-audit #12633)", () => {
  test("findProtectedNamespace resolves the owning namespace for gated prefixes", () => {
    expect(findProtectedNamespace("/api/local-inference/hub")?.prefix).toBe(
      "/api/local-inference/",
    );
    expect(findProtectedNamespace("/api/cloud/status")?.prefix).toBe(
      "/api/cloud/",
    );
    expect(findProtectedNamespace("/api/agents")).toBeNull();
  });

  test("the bare namespace root (no trailing slash) is still treated as protected", () => {
    // `/api/cloud` (no trailing slash) must not slip past the prefix rule and
    // default-allow — it resolves to its namespace and fails closed.
    expect(findProtectedNamespace("/api/cloud")?.prefix).toBe("/api/cloud/");
    expect(findProtectedNamespace("/api/local-inference")?.prefix).toBe(
      "/api/local-inference/",
    );
    for (const mode of ["local", "local-only", "cloud", "remote"] as const) {
      expect(
        isRouteVisible({ pathname: "/api/cloud", method: "GET", mode }),
        `bare /api/cloud in ${mode}`,
      ).toBe(false);
      expect(
        isRouteVisible({
          pathname: "/api/local-inference",
          method: "GET",
          mode,
        }),
        `bare /api/local-inference in ${mode}`,
      ).toBe(false);
    }
    // A sibling that merely shares a prefix segment must NOT be captured.
    expect(findProtectedNamespace("/api/cloudy")).toBeNull();
    expect(findProtectedNamespace("/api/local-inference-docs")).toBeNull();
  });

  test("protected namespaces never fail-OPEN: gated prefixes hide in their excluded mode", () => {
    // The drift the audit calls out: a sub-route under a gated prefix must
    // never be served in a mode the namespace excludes. Catch-all prefix
    // rules guarantee this for every child path today.
    expect(
      isRouteVisible({
        pathname: "/api/local-inference/hub",
        method: "GET",
        mode: "cloud",
      }),
    ).toBe(false);
    expect(
      isRouteVisible({
        pathname: "/api/local-inference/anything/deeper",
        method: "POST",
        mode: "remote",
      }),
    ).toBe(false);
    expect(
      isRouteVisible({
        pathname: "/api/cloud/some/new/child",
        method: "GET",
        mode: "local-only",
      }),
    ).toBe(false);
  });

  test("a protected path with NO governing rule fails closed in every mode", () => {
    // Prove the pure fail-closed branch of isRouteVisible directly: for any
    // protected namespace, a child path that no rule governs must be hidden
    // in every runtime mode (never default-allow). We construct the branch by
    // asserting the invariant: protected + (rule ? excluded-somewhere : hidden).
    for (const ns of PROTECTED_MODE_NAMESPACES) {
      const child = `${ns.prefix}__drift_probe_never_declared__`;
      const rule = findRouteModeRule(child, "GET");
      const modes = ["local", "local-only", "cloud", "remote"] as const;
      const visibility = modes.map((mode) =>
        isRouteVisible({ pathname: child, method: "GET", mode }),
      );
      if (rule) {
        // Governed by the catch-all prefix rule: must be hidden in at least
        // one mode (each protected namespace excludes ≥ 1 mode), never
        // visible in all four.
        expect(visibility.every(Boolean)).toBe(false);
      } else {
        // No rule at all ⇒ fail closed everywhere.
        expect(visibility.some(Boolean)).toBe(false);
      }
    }
  });
});

describe("route-mode matrix reconciliation (owner-declared contract)", () => {
  test("every rule with a non-null owner names a declared namespace prefix", () => {
    const prefixes = new Set(PROTECTED_MODE_NAMESPACES.map((n) => n.prefix));
    for (const rule of ROUTE_MODE_MATRIX) {
      if (rule.owner === null) continue;
      expect(prefixes.has(rule.owner), `${rule.path} owner`).toBe(true);
      expect(rule.path.startsWith(rule.owner), `${rule.path} under owner`).toBe(
        true,
      );
    }
  });

  test("every declared protected namespace has at least one matrix rule", () => {
    for (const ns of PROTECTED_MODE_NAMESPACES) {
      const covered = ROUTE_MODE_MATRIX.some((r) => r.owner === ns.prefix);
      expect(covered, `namespace ${ns.prefix} covered`).toBe(true);
    }
  });

  test("assertMatrixReconciled passes for the shipped matrix", () => {
    expect(() => assertMatrixReconciled()).not.toThrow();
  });
});

describe("isRouteVisibleWith fail-closed branch (drift/failure mode)", () => {
  // The shipped matrix uses catch-all prefix rules, so every child of a
  // protected namespace matches a rule. To prove the fail-closed branch
  // itself — the exact unsafe coupling this audit removes — we feed a
  // synthetic protected namespace that has NO covering rule and confirm the
  // path is hidden in EVERY mode instead of default-allowed.
  const syntheticNamespaces = [
    {
      prefix: "/api/__synthetic_gated__/",
      owner: "test fixture",
      reason: "exercise fail-closed branch",
    },
  ] as const;

  test("a protected path with no matching rule is hidden in every mode", () => {
    for (const mode of ["local", "local-only", "cloud", "remote"] as const) {
      expect(
        isRouteVisibleWith([], syntheticNamespaces, {
          pathname: "/api/__synthetic_gated__/thing",
          method: "GET",
          mode,
        }),
        `mode ${mode}`,
      ).toBe(false);
    }
  });

  test("a non-protected path with no matching rule default-allows in every mode", () => {
    for (const mode of ["local", "local-only", "cloud", "remote"] as const) {
      expect(
        isRouteVisibleWith([], syntheticNamespaces, {
          pathname: "/api/public/thing",
          method: "GET",
          mode,
        }),
        `mode ${mode}`,
      ).toBe(true);
    }
  });

  test("an explicit rule still wins over the protected-namespace fail-close", () => {
    const rules = [
      {
        path: "/api/__synthetic_gated__/allowed",
        method: "GET" as const,
        modes: ["cloud"] as const,
        owner: "/api/__synthetic_gated__/",
        reason: "fixture allow in cloud",
      },
    ];
    expect(
      isRouteVisibleWith(rules, syntheticNamespaces, {
        pathname: "/api/__synthetic_gated__/allowed",
        method: "GET",
        mode: "cloud",
      }),
    ).toBe(true);
    expect(
      isRouteVisibleWith(rules, syntheticNamespaces, {
        pathname: "/api/__synthetic_gated__/allowed",
        method: "GET",
        mode: "local",
      }),
    ).toBe(false);
  });
});
