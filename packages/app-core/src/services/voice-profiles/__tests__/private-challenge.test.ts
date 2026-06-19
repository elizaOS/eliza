import { describe, expect, it } from "vitest";
import { InMemoryChallengeService } from "../private-challenge.ts";

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
});
