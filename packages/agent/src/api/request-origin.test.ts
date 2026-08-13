/**
 * Deterministically verifies external request-origin reconstruction from proxy
 * chains, direct Host headers, TLS socket state, and missing host metadata.
 */

import type http from "node:http";
import { describe, expect, it } from "vitest";
import {
  resolveDirectRequestOrigin,
  resolveRequestOrigin,
} from "./request-origin.js";

function request(
  headers: http.IncomingHttpHeaders,
  encrypted = false,
): http.IncomingMessage {
  return {
    headers,
    socket: { encrypted },
  } as unknown as http.IncomingMessage;
}

describe("resolveRequestOrigin", () => {
  it("uses the client-facing first proxy values", () => {
    expect(
      resolveRequestOrigin(
        request({
          host: "127.0.0.1:2138",
          "x-forwarded-proto": "https, http",
          "x-forwarded-host": "eliza.example, proxy.internal",
        }),
      ),
    ).toBe("https://eliza.example");
  });

  it("uses TLS state and Host for a direct request", () => {
    expect(resolveRequestOrigin(request({ host: "eliza.example" }, true))).toBe(
      "https://eliza.example",
    );
  });

  it("uses http for a direct cleartext request", () => {
    expect(resolveRequestOrigin(request({ host: "127.0.0.1:2138" }))).toBe(
      "http://127.0.0.1:2138",
    );
  });

  it("ignores spoofable forwarding headers at a direct-request boundary", () => {
    expect(
      resolveDirectRequestOrigin(
        request({
          host: "127.0.0.1:2138",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "attacker.example",
        }),
      ),
    ).toBe("http://127.0.0.1:2138");
  });

  it("returns empty when no host metadata exists", () => {
    expect(resolveRequestOrigin(request({}))).toBe("");
  });
});
