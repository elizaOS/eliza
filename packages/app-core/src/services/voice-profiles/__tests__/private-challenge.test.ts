/**
 * Unit tests for InMemoryChallengeService: issuing a challenge with a
 * sha256-hashed expected answer, single-use correct verification, rejection of
 * wrong/unknown/expired challenges, and the id+seed default-hash path used
 * when no expected answer is configured. Uses an injectable clock for expiry.
 */
import { describe, expect, it } from "vitest";
import { InMemoryChallengeService } from "../private-challenge.ts";

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("InMemoryChallengeService", () => {
  it("issues a challenge with hashed expected answer", async () => {
    const svc = new InMemoryChallengeService({ expectedAnswer: "open sesame" });
    const c = await svc.issue("Confirm phrase");
    expect(c.id.length).toBeGreaterThan(0);
    expect(c.expectedAnswerHash.length).toBe(64);
    expect(c.expectedAnswerHash).not.toBe("open sesame");
  });

  it("verify accepts correct answer once", async () => {
    const svc = new InMemoryChallengeService({ expectedAnswer: "open sesame" });
    const c = await svc.issue();
    expect(await svc.verify(c.id, "open sesame")).toBe(true);
    expect(await svc.verify(c.id, "open sesame")).toBe(false);
  });

  it("verify rejects wrong answer", async () => {
    const svc = new InMemoryChallengeService({ expectedAnswer: "open sesame" });
    const c = await svc.issue();
    expect(await svc.verify(c.id, "wrong")).toBe(false);
  });

  it("verify rejects unknown id", async () => {
    const svc = new InMemoryChallengeService();
    expect(await svc.verify("nope", "anything")).toBe(false);
  });

  it("verify rejects expired challenge", async () => {
    let t = 0;
    const svc = new InMemoryChallengeService({
      now: () => t,
      ttlMs: 1_000,
      expectedAnswer: "ok",
    });
    const c = await svc.issue();
    t = c.expiresAt + 1;
    expect(await svc.verify(c.id, "ok")).toBe(false);
  });

  it("uses id+seed for default hashing when no expected answer is provided", async () => {
    const svc = new InMemoryChallengeService();
    const c = await svc.issue("seedval");
    expect(await svc.verify(c.id, `${c.id}:seedval`)).toBe(true);
  });

  it("verifies at exactly expiresAt (inclusive boundary)", async () => {
    let t = 0;
    const svc = new InMemoryChallengeService({
      now: () => t,
      ttlMs: 1_000,
      expectedAnswer: "ok",
    });
    const c = await svc.issue();
    t = c.expiresAt;
    expect(await svc.verify(c.id, "ok")).toBe(true);
  });

  it("expiry permanently consumes the challenge", async () => {
    let t = 0;
    const svc = new InMemoryChallengeService({
      now: () => t,
      ttlMs: 1_000,
      expectedAnswer: "ok",
    });
    const c = await svc.issue();
    t = c.expiresAt + 1;
    expect(await svc.verify(c.id, "ok")).toBe(false);
    t = c.createdAt;
    expect(await svc.verify(c.id, "ok")).toBe(false);
  });

  it("does not consume the challenge on a wrong answer", async () => {
    const svc = new InMemoryChallengeService({ expectedAnswer: "open sesame" });
    const c = await svc.issue();
    expect(await svc.verify(c.id, "wrong")).toBe(false);
    expect(await svc.verify(c.id, "open sesame")).toBe(true);
  });

  it("hashes the configured expected answer with sha256 hex encoding", async () => {
    const svc = new InMemoryChallengeService({ expectedAnswer: "open sesame" });
    const c = await svc.issue();
    expect(c.expectedAnswerHash).toBe(await sha256Hex("open sesame"));
  });

  it("keeps concurrent challenges independent", async () => {
    const svc = new InMemoryChallengeService({ expectedAnswer: "open sesame" });
    const a = await svc.issue("first");
    const b = await svc.issue("second");
    expect(a.id).not.toBe(b.id);
    expect(a.prompt).toBe("first");
    expect(b.prompt).toBe("second");
    expect(await svc.verify(a.id, "open sesame")).toBe(true);
    expect(await svc.verify(b.id, "open sesame")).toBe(true);
    expect(await svc.verify(b.id, "open sesame")).toBe(false);
  });

  it("applies the requested ttl window and the default five-minute window", async () => {
    const t = 500;
    const custom = new InMemoryChallengeService({
      now: () => t,
      ttlMs: 1_234,
    });
    const c = await custom.issue();
    expect(c.createdAt).toBe(500);
    expect(c.expiresAt - c.createdAt).toBe(1_234);
    const def = new InMemoryChallengeService({ now: () => t });
    const d = await def.issue();
    expect(d.expiresAt - d.createdAt).toBe(5 * 60_000);
  });
});
