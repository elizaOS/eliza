import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStewardCanonicalRequest,
  signStewardMutatingRequest,
} from "../src/steward/sign";

// gitleaks:allow — synthetic test value, no entropy / real-key shape needed.
const SECRET = "test_only_steward_secret_aaaaaaaaaaaaa";

// Independent re-implementation of the HMAC the way Steward verifies it, so the
// test proves the signature actually validates rather than just matching shape.
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("steward sign.ts", () => {
  it("buildStewardCanonicalRequest emits the 15-field v1 canonical in order", async () => {
    const headers = new Headers({
      "x-steward-tenant": "elizacloud",
      "idempotency-key": "idem-1",
      "x-steward-request-expires-at": "1780000000",
    });
    const body = new TextEncoder().encode(JSON.stringify({ code: "n" }));
    const canonical = await buildStewardCanonicalRequest(
      "post",
      "/auth/oauth/exchange",
      headers,
      body,
    );
    const lines = canonical.split("\n");
    expect(lines).toHaveLength(15);
    expect(lines[0]).toBe("steward-request-signature-v1");
    expect(lines[1]).toBe("POST"); // method upcased
    expect(lines[2]).toBe("/auth/oauth/exchange");
    expect(lines[3]).toBe("elizacloud"); // x-steward-tenant verbatim
    expect(lines[12]).toBe("1780000000"); // expires-at verbatim
    expect(lines[13]).toBe("idem-1"); // idempotency-key verbatim
    expect(lines[14]).toMatch(/^[0-9a-f]{64}$/); // body sha256
  });

  it("signStewardMutatingRequest stamps freshness + idempotency + a verifiable v1 signature", async () => {
    const fixedMs = Date.parse("2026-06-05T15:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(fixedMs);
    const headers = new Headers({
      "content-type": "application/json",
      "x-steward-tenant": "elizacloud",
    });
    const body = new TextEncoder().encode(
      JSON.stringify({ code: "nonce", code_verifier: "v" }),
    );
    await signStewardMutatingRequest(
      SECRET,
      "POST",
      "/auth/oauth/exchange",
      headers,
      body,
    );

    // 60s freshness window, inside Steward's ±5min tolerance.
    expect(headers.get("x-steward-request-expires-at")).toBe(
      String(Math.floor(fixedMs / 1000) + 60),
    );
    expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    const sig = headers.get("x-steward-signature");
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);

    // Recompute over the exact signed headers/body — Steward's check must pass.
    const canonical = await buildStewardCanonicalRequest(
      "POST",
      "/auth/oauth/exchange",
      headers,
      body,
    );
    expect(sig).toBe(`v1=${await hmacSha256Hex(SECRET, canonical)}`);
  });

  it("preserves a caller-supplied Idempotency-Key instead of overwriting it", async () => {
    const headers = new Headers({ "idempotency-key": "caller-key-123" });
    const body = new TextEncoder().encode("{}");
    await signStewardMutatingRequest(SECRET, "POST", "/auth/x", headers, body);
    expect(headers.get("idempotency-key")).toBe("caller-key-123");
  });

  it("binds the signature to the body — a tampered body no longer verifies", async () => {
    const headers = new Headers({ "x-steward-tenant": "elizacloud" });
    const body = new TextEncoder().encode(JSON.stringify({ code: "real" }));
    await signStewardMutatingRequest(SECRET, "POST", "/auth/x", headers, body);
    const tampered = new TextEncoder().encode(JSON.stringify({ code: "evil" }));
    const canonicalForTampered = await buildStewardCanonicalRequest(
      "POST",
      "/auth/x",
      headers,
      tampered,
    );
    expect(headers.get("x-steward-signature")).not.toBe(
      `v1=${await hmacSha256Hex(SECRET, canonicalForTampered)}`,
    );
  });
});
