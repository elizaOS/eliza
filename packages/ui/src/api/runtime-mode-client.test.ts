/** Covers the runtime-mode snapshot client's validation and fallback contract against a stubbed global fetch. */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { fetchRuntimeModeSnapshot } from "./runtime-mode-client";

const fetchMock = vi.fn<typeof fetch>();

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchRuntimeModeSnapshot", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
    window.sessionStorage.removeItem("elizaos_api_base");
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okResponse({}));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    setBootConfig({ branding: {} });
    vi.unstubAllGlobals();
  });

  it("returns the validated snapshot and strips the apiBase trailing slash from the request URL", async () => {
    setBootConfig({
      branding: {},
      apiBase: "http://agent.example.com/",
    });
    const snapshot = {
      mode: "remote",
      deploymentRuntime: "cloud",
      isRemoteController: true,
      remoteApiBaseConfigured: true,
    };
    fetchMock.mockResolvedValue(okResponse(snapshot));

    await expect(fetchRuntimeModeSnapshot()).resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://agent.example.com/api/runtime/mode",
    );
  });

  it("requests window.location.origin when no apiBase is configured", async () => {
    fetchMock.mockResolvedValue(okResponse({}));

    await expect(fetchRuntimeModeSnapshot()).resolves.toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://localhost/api/runtime/mode",
    );
  });

  it("accepts every documented mode value", async () => {
    for (const mode of ["local", "local-only", "cloud", "remote"] as const) {
      fetchMock.mockResolvedValue(
        okResponse({
          mode,
          deploymentRuntime: "local",
          isRemoteController: false,
          remoteApiBaseConfigured: false,
        }),
      );

      await expect(fetchRuntimeModeSnapshot()).resolves.toEqual({
        mode,
        deploymentRuntime: "local",
        isRemoteController: false,
        remoteApiBaseConfigured: false,
      });
    }
  });

  it("accepts every documented deploymentRuntime value", async () => {
    for (const deploymentRuntime of ["local", "cloud", "remote"] as const) {
      fetchMock.mockResolvedValue(
        okResponse({
          mode: "local",
          deploymentRuntime,
          isRemoteController: false,
          remoteApiBaseConfigured: false,
        }),
      );

      await expect(fetchRuntimeModeSnapshot()).resolves.toMatchObject({
        deploymentRuntime,
      });
    }
  });

  it("coerces truthy-but-not-true snapshot booleans to false", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        mode: "remote",
        deploymentRuntime: "cloud",
        isRemoteController: "true",
        remoteApiBaseConfigured: 1,
      }),
    );

    await expect(fetchRuntimeModeSnapshot()).resolves.toEqual({
      mode: "remote",
      deploymentRuntime: "cloud",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
  });

  it("defaults missing snapshot booleans to false", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ mode: "local", deploymentRuntime: "local" }),
    );

    await expect(fetchRuntimeModeSnapshot()).resolves.toEqual({
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
  });

  it("returns null when the endpoint is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(fetchRuntimeModeSnapshot()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null on a non-2xx response", async () => {
    for (const status of [404, 500]) {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ mode: "local" }), { status }),
      );

      await expect(fetchRuntimeModeSnapshot()).resolves.toBeNull();
    }
  });

  it("returns null when the body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>not json</html>"));

    await expect(fetchRuntimeModeSnapshot()).resolves.toBeNull();
  });

  it("returns null when the body is JSON null", async () => {
    fetchMock.mockResolvedValue(new Response("null"));

    await expect(fetchRuntimeModeSnapshot()).resolves.toBeNull();
  });

  it("returns null for an unknown mode", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        mode: "hybrid",
        deploymentRuntime: "local",
        isRemoteController: false,
        remoteApiBaseConfigured: false,
      }),
    );

    await expect(fetchRuntimeModeSnapshot()).resolves.toBeNull();
  });

  it("returns null for an unknown deploymentRuntime", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        mode: "local",
        deploymentRuntime: "local-only",
        isRemoteController: false,
        remoteApiBaseConfigured: false,
      }),
    );

    await expect(fetchRuntimeModeSnapshot()).resolves.toBeNull();
  });
});
