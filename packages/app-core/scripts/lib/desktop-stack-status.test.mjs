import { describe, expect, it, vi } from "vitest";
import { gatherDesktopStackStatus } from "./desktop-stack-status.mjs";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("gatherDesktopStackStatus", () => {
  it("defaults the API probe to the canonical desktop API port", async () => {
    const checkedPorts = [];
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/api/dev/stack")) {
        return jsonResponse(200, {
          desktop: { uiPort: 2138, rendererUrl: null },
        });
      }
      return jsonResponse(200, { state: "ready" });
    });

    const report = await gatherDesktopStackStatus({}, fetchImpl, {
      isPortOpen: async (port) => {
        checkedPorts.push(port);
        return port === 31337;
      },
    });

    expect(report.apiPort).toBe(31337);
    expect(report.apiListening).toBe(true);
    expect(checkedPorts).toContain(31337);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:31337/api/dev/stack",
      expect.any(Object),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:31337/api/health",
      expect.any(Object),
    );
  });

  it("detects an API-only stack when Vite is stopped", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/api/dev/stack")) {
        return jsonResponse(200, {
          desktop: { uiPort: 2138, rendererUrl: null },
        });
      }
      return jsonResponse(200, { state: "ready" });
    });

    const report = await gatherDesktopStackStatus({}, fetchImpl, {
      isPortOpen: async (port) => port === 31337,
    });

    expect(report.apiPort).toBe(31337);
    expect(report.apiListening).toBe(true);
    expect(report.uiPort).toBe(2138);
    expect(report.uiListening).toBe(false);
    expect(report.apiHealth.ok).toBe(true);
  });
});
