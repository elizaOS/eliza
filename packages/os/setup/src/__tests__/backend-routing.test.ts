// Locks browser/dev proxy and packaged direct-backend request routing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAospFlasherBackend } from "../backend/http-backend";

afterEach(() => {
  delete window.__ELIZA_SERVER_TOKEN__;
  vi.unstubAllGlobals();
});

describe("Android backend routing", () => {
  it.each([
    [
      "packaged direct injection",
      "http://127.0.0.1:4242",
      "http://127.0.0.1:4242/devices",
    ],
    ["browser development proxy", "/api", "/api/devices"],
  ])(
    "uses %s without appending a duplicate /api",
    async (_mode, base, expected) => {
      window.__ELIZA_SERVER_TOKEN__ = "route-test-token";
      const fetchMock = vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >(async () => Response.json([]));
      vi.stubGlobal("fetch", fetchMock);

      await new HttpAospFlasherBackend(base).listConnectedDevices();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(expected);
    },
  );
});
