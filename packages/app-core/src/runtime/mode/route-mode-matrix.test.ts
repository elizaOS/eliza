import { describe, expect, test } from "vitest";
import { findRouteModeRule, isRouteVisible } from "./route-mode-matrix";
import { resolveRuntimeMode } from "./runtime-mode";

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

  test("remote includes the remoteApiBase + token", () => {
    const snap = resolveRuntimeMode({
      deploymentTarget: {
        runtime: "remote",
        remoteApiBase: "http://10.0.0.5:31337",
        remoteAccessToken: "secret",
      },
    });
    expect(snap.mode).toBe("remote");
    expect(snap.remoteApiBase).toBe("http://10.0.0.5:31337");
    expect(snap.remoteAccessToken).toBe("secret");
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

  test("/api/tts/cloud is hidden in local-only mode", () => {
    expect(
      isRouteVisible({
        pathname: "/api/tts/cloud",
        method: "POST",
        mode: "local-only",
      }),
    ).toBe(false);
  });

  test("findRouteModeRule returns null for un-matrixed routes (default-allow)", () => {
    expect(findRouteModeRule("/api/agent/reset", "POST")).toBeNull();
    expect(
      isRouteVisible({
        pathname: "/api/agent/reset",
        method: "POST",
        mode: "cloud",
      }),
    ).toBe(true);
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
