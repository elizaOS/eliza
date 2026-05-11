import { describe, expect, test } from "vitest";
import { findRouteModeRule, isRouteVisible } from "./route-mode-matrix";
import { resolveRuntimeMode, validateRemoteApiBase } from "./runtime-mode";

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
