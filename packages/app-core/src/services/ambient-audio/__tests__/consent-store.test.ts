import { describe, expect, it } from "vitest";
import { ConsentStore } from "../consent-store.ts";

describe("ConsentStore", () => {
  it("starts in off mode with no consent", () => {
    const s = new ConsentStore();
    expect(s.currentMode()).toBe("off");
    expect(s.consent()).toBeNull();
  });

  it("grant transitions to capturing and records consent", () => {
    const t = 1000;
    const s = new ConsentStore(() => t);
    const rec = s.grant("household");
    expect(s.currentMode()).toBe("capturing");
    expect(rec.scope).toBe("household");
    expect(rec.grantedAt).toBe(1000);
    expect(rec.mode).toBe("capturing");
  });

  it("pause then resume returns to capturing", () => {
    const s = new ConsentStore();
    s.grant("owner-only");
    s.pause();
    expect(s.currentMode()).toBe("paused");
    s.resume();
    expect(s.currentMode()).toBe("capturing");
  });

  it("revoke clears consent and returns to off", () => {
    const s = new ConsentStore();
    s.grant("household");
    s.revoke();
    expect(s.currentMode()).toBe("off");
    expect(s.consent()).toBeNull();
  });

  it("pause without consent throws", () => {
    const s = new ConsentStore();
    expect(() => s.pause()).toThrow();
  });

  it("resume requires paused mode", () => {
    const s = new ConsentStore();
    s.grant("household");
    expect(() => s.resume()).toThrow();
  });

  it("serializes and hydrates preserving state", () => {
    const s = new ConsentStore();
    s.grant("owner-only");
    s.pause();
    const snap = s.serialize();
    const s2 = ConsentStore.hydrate(snap);
    expect(s2.currentMode()).toBe("paused");
    expect(s2.consent()?.scope).toBe("owner-only");
  });
});
