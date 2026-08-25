/**
 * Exercises cron-secret auth behavior with a deterministic harness: explicit
 * env objects (with the ambient CRON_SECRET cleared around every case) and
 * plain Request objects — no network, no timers, no logger assertions. The
 * suite is real-unit (bun test via the package test lane).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { timingSafeEqualSecret, verifyCronSecret } from "./cron";

function cronRequest(headers: Record<string, string>): Request {
  return new Request("https://cloud.example.com/api/cron/job", { headers });
}

async function expectJson(response: Response | null, status: number, error: string) {
  expect(response, "rejected requests must resolve to an error Response").not.toBeNull();
  expect(response!.status).toBe(status);
  await expect(response!.json()).resolves.toEqual({ error });
}

describe("timingSafeEqualSecret", () => {
  it("returns true only for an exact match", () => {
    expect(timingSafeEqualSecret("s3cr3t-token", "s3cr3t-token")).toBe(true);
  });

  it("returns false for a same-length mismatch", () => {
    expect(timingSafeEqualSecret("s3cr3t-token", "s3cr3t-tokeX")).toBe(false);
    // a one-character difference at the start must not short-circuit to true
    expect(timingSafeEqualSecret("Xs3cr3t-toke", "s3cr3t-tokeX")).toBe(false);
  });

  it("returns false on any length mismatch (no prefix match)", () => {
    expect(timingSafeEqualSecret("secret", "secretpadding")).toBe(false);
    expect(timingSafeEqualSecret("secretpadding", "secret")).toBe(false);
    // an empty provided value never matches a configured secret
    expect(timingSafeEqualSecret("", "secret")).toBe(false);
  });

  it("handles unicode/byte-length differences", () => {
    // "é" is two UTF-8 bytes; the buffers differ in length from the ascii form
    expect(timingSafeEqualSecret("café", "cafe")).toBe(false);
    expect(timingSafeEqualSecret("café", "café")).toBe(true);
  });
});

describe("verifyCronSecret", () => {
  const originalSecret = process.env.CRON_SECRET;
  const SECRET = "unit-test-cron-secret";

  beforeEach(() => {
    // verifyCronSecret falls back to process.env when the explicit env value
    // is undefined, so the ambient variable must be cleared for every case
    // to keep the explicit-env tests hermetic
    delete process.env.CRON_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalSecret;
    }
  });

  it("returns null when the Bearer token matches", () => {
    const request = cronRequest({ authorization: `Bearer ${SECRET}` });
    expect(verifyCronSecret(request, "[Cron]", { CRON_SECRET: SECRET })).toBeNull();
  });

  it("matches the Bearer scheme case-insensitively", () => {
    // the header parser accepts "bearer"/"BEARER" like production cron schedulers emit
    const request = cronRequest({ authorization: `BEARER ${SECRET}` });
    expect(verifyCronSecret(request, "[Cron]", { CRON_SECRET: SECRET })).toBeNull();
  });

  it("falls back to the x-cron-secret header when Authorization is absent", () => {
    const request = cronRequest({ "x-cron-secret": SECRET });
    expect(verifyCronSecret(request, "[Cron]", { CRON_SECRET: SECRET })).toBeNull();
  });

  it("prefers the Authorization header over x-cron-secret when both are present", () => {
    // a stale legacy header must not override the bearer credential
    const request = cronRequest({
      authorization: `Bearer ${SECRET}`,
      "x-cron-secret": "wrong-legacy-secret",
    });
    expect(verifyCronSecret(request, "[Cron]", { CRON_SECRET: SECRET })).toBeNull();
  });

  it("returns 503 (server misconfiguration) when CRON_SECRET is not set", async () => {
    await expectJson(
      verifyCronSecret(cronRequest({}), "[Cron]", { CRON_SECRET: undefined }),
      503,
      "Server configuration error: CRON_SECRET not set",
    );
  });

  it("treats an empty-string CRON_SECRET as unconfigured (503, not 401)", async () => {
    // an empty configured secret must never be satisfiable by an empty client value
    await expectJson(
      verifyCronSecret(cronRequest({}), "[Cron]", { CRON_SECRET: "" }),
      503,
      "Server configuration error: CRON_SECRET not set",
    );
  });

  it("returns 401 for a wrong same-length Bearer secret", async () => {
    const request = cronRequest({ authorization: `Bearer ${SECRET.slice(0, -1)}X` });
    await expectJson(
      verifyCronSecret(request, "[Cron]", { CRON_SECRET: SECRET }),
      401,
      "Unauthorized",
    );
  });

  it("returns 401 when no credential header is present at all", async () => {
    await expectJson(
      verifyCronSecret(cronRequest({}), "[Cron]", { CRON_SECRET: SECRET }),
      401,
      "Unauthorized",
    );
  });

  it("strips the Bearer scheme even when separated by a tab", () => {
    // Request header normalization collapses "Bearer " to "Bearer" (no
    // whitespace left for the regex), but a tab separator survives — so the
    // tab form is the reachable input that exercises prefix stripping
    const request = cronRequest({ authorization: `Bearer\t${SECRET}` });
    expect(verifyCronSecret(request, "[Cron]", { CRON_SECRET: SECRET })).toBeNull();
  });

  it("returns 401 for a bare scheme-only Authorization header", async () => {
    // Request normalizes "Bearer " (trailing space) to "Bearer"; the regex
    // does not match the bare scheme, so the whole header value remains the
    // comparison candidate and must not equal the configured secret
    const request = cronRequest({ authorization: "Bearer" });
    await expectJson(
      verifyCronSecret(request, "[Cron]", { CRON_SECRET: SECRET }),
      401,
      "Unauthorized",
    );
  });

  it("returns 401 when x-cron-secret is wrong even if it matches in length", async () => {
    const request = cronRequest({ "x-cron-secret": `${SECRET.slice(0, -1)}Y` });
    await expectJson(
      verifyCronSecret(request, "[Cron]", { CRON_SECRET: SECRET }),
      401,
      "Unauthorized",
    );
  });

  it("does not accept a secret that is a strict prefix of the configured one", async () => {
    const request = cronRequest({ "x-cron-secret": SECRET.slice(0, 6) });
    await expectJson(
      verifyCronSecret(request, "[Cron]", { CRON_SECRET: SECRET }),
      401,
      "Unauthorized",
    );
  });

  it("falls back to process.env.CRON_SECRET when no env object is passed", () => {
    process.env.CRON_SECRET = SECRET;
    try {
      const request = cronRequest({ authorization: `Bearer ${SECRET}` });
      expect(verifyCronSecret(request)).toBeNull();
    } finally {
      delete process.env.CRON_SECRET;
    }
  });

  it("returns 503 via process.env when the variable is unset and no env object is passed", async () => {
    await expectJson(
      verifyCronSecret(cronRequest({})),
      503,
      "Server configuration error: CRON_SECRET not set",
    );
  });

  it("accepts the secret in Authorization even without the Bearer scheme", () => {
    // the parser strips only the Bearer prefix, so the raw header value stays
    // the comparison candidate and must still equal the configured secret
    const request = cronRequest({ authorization: SECRET });
    expect(verifyCronSecret(request, "[Cron]", { CRON_SECRET: SECRET })).toBeNull();
  });
});
