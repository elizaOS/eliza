/**
 * Covers the proactive-interaction gate — the UX governance that decides whether
 * a proactive comment is allowed: global and per-surface cooldowns, textual
 * dedup, daily cap, burst debounce/settling, and the chattiness/kill-switch
 * config resolution (env + user setting). Pure and deterministic — the gate is
 * driven with explicit injected `now` timestamps, no clock or model.
 */
import { describe, expect, it } from "vitest";
import {
  configForChattiness,
  ProactiveInteractionGate,
  resolveProactiveChattiness,
  resolveProactiveGateConfig,
} from "./proactive-interaction-gate.ts";

const SUBTLE = configForChattiness("subtle");

function gate(config = SUBTLE) {
  return new ProactiveInteractionGate(config);
}

describe("ProactiveInteractionGate — UX governance (#8792)", () => {
  it("admits a first, settled, in-budget comment", () => {
    const g = gate();
    const r = g.tryAdmit({ surface: "wallet", text: "pull balances?", now: 0 });
    expect(r.admitted).toBe(true);
  });

  it("enforces the global cooldown across surfaces", () => {
    const g = gate();
    expect(g.tryAdmit({ surface: "wallet", text: "a", now: 0 }).admitted).toBe(
      true,
    );
    // A different surface still hits the global cooldown.
    const r = g.tryAdmit({ surface: "calendar", text: "b", now: 30_000 });
    expect(r.admitted).toBe(false);
    expect(r.reason).toContain("global cooldown");
    // After the global cooldown passes, a new surface is admitted.
    expect(
      g.tryAdmit({
        surface: "calendar",
        text: "b",
        now: SUBTLE.globalCooldownMs,
      }).admitted,
    ).toBe(true);
  });

  it("enforces a longer per-surface cooldown", () => {
    const g = gate();
    g.tryAdmit({ surface: "wallet", text: "a", now: 0 });
    // Past the global cooldown but not the per-surface cooldown for wallet.
    const t = SUBTLE.globalCooldownMs + 1;
    const r = g.tryAdmit({ surface: "wallet", text: "different", now: t });
    expect(r.admitted).toBe(false);
    expect(r.reason).toContain("per-surface cooldown");
    // A different surface at the same time is fine (global cooldown elapsed).
    expect(g.tryAdmit({ surface: "todos", text: "x", now: t }).admitted).toBe(
      true,
    );
  });

  it("suppresses a textual duplicate on the same surface", () => {
    const g = gate(configForChattiness("chatty")); // short cooldowns
    const cfg = configForChattiness("chatty");
    g.tryAdmit({ surface: "wallet", text: "Pull balances?", now: 0 });
    // Past both cooldowns, but identical text → deduped.
    const t = cfg.perSurfaceCooldownMs + 1;
    const r = g.tryAdmit({ surface: "wallet", text: "pull balances?", now: t });
    expect(r.admitted).toBe(false);
    expect(r.reason).toContain("duplicate");
  });

  it("enforces the daily cap", () => {
    const cfg = { ...configForChattiness("chatty"), dailyCap: 2 };
    const g = gate(cfg);
    // Space emissions past cooldowns so only the daily cap can stop them.
    const step = cfg.perSurfaceCooldownMs + 1;
    let now = 0;
    let admitted = 0;
    for (let i = 0; i < 5; i++) {
      const r = g.tryAdmit({ surface: `s${i}`, text: `t${i}`, now });
      if (r.admitted) admitted++;
      now += step;
    }
    expect(admitted).toBe(2);
  });

  it("debounces a burst: only the settled view comments", () => {
    const g = gate();
    g.noteSwitch("wallet", 0);
    // Another switch right after → wallet not settled yet.
    g.noteSwitch("wallet", 500);
    const early = g.tryAdmit({ surface: "wallet", text: "a", now: 800 });
    expect(early.admitted).toBe(false);
    expect(early.reason).toContain("debounce");
    // Once debounceMs elapses with no newer switch, it settles.
    const settled = g.tryAdmit({
      surface: "wallet",
      text: "a",
      now: 500 + SUBTLE.debounceMs,
    });
    expect(settled.admitted).toBe(true);
  });

  it("keeps an older surface quiet after a newer surface wins the burst", () => {
    const g = gate();
    g.noteSwitch("wallet", 0);
    g.noteSwitch("calendar", 500);

    expect(g.isSettled("wallet", 500 + SUBTLE.debounceMs)).toBe(false);
    expect(g.isSettled("calendar", 500 + SUBTLE.debounceMs)).toBe(true);
  });

  it("is fully disabled when chattiness is off", () => {
    const g = gate(configForChattiness("off"));
    const r = g.tryAdmit({ surface: "wallet", text: "a", now: 0 });
    expect(r.admitted).toBe(false);
    expect(r.reason).toBe("disabled");
  });
});

describe("resolveProactiveChattiness — kill-switch + setting", () => {
  it("ELIZA_DISABLE_PROACTIVE_AGENT forces off", () => {
    expect(
      resolveProactiveChattiness({ ELIZA_DISABLE_PROACTIVE_AGENT: "1" }),
    ).toBe("off");
    expect(
      resolveProactiveChattiness({ ELIZA_DISABLE_PROACTIVE_AGENT: "true" }),
    ).toBe("off");
  });

  it("defaults to subtle and respects the user setting / env", () => {
    expect(resolveProactiveChattiness({})).toBe("subtle");
    expect(resolveProactiveChattiness({}, "chatty")).toBe("chatty");
    expect(
      resolveProactiveChattiness({ ELIZA_PROACTIVE_INTERACTIONS: "off" }),
    ).toBe("off");
    // The user setting wins over env.
    expect(
      resolveProactiveChattiness(
        { ELIZA_PROACTIVE_INTERACTIONS: "chatty" },
        "off",
      ),
    ).toBe("off");
  });

  it("kill-switch overrides any setting", () => {
    expect(
      resolveProactiveChattiness(
        { ELIZA_DISABLE_PROACTIVE_AGENT: "yes" },
        "chatty",
      ),
    ).toBe("off");
    expect(
      resolveProactiveGateConfig(
        { ELIZA_DISABLE_PROACTIVE_AGENT: "yes" },
        "chatty",
      ).chattiness,
    ).toBe("off");
  });

  it("allows the live e2e lane to shorten the global cooldown explicitly", () => {
    const cfg = resolveProactiveGateConfig({
      ELIZA_PROACTIVE_INTERACTIONS: "chatty",
      ELIZA_PROACTIVE_INTERACTIONS_TEST_COOLDOWN_MS: "5000",
    });
    expect(cfg.chattiness).toBe("chatty");
    expect(cfg.globalCooldownMs).toBe(5_000);
    expect(cfg.perSurfaceCooldownMs).toBe(
      configForChattiness("chatty").perSurfaceCooldownMs,
    );
  });

  it("ignores invalid test cooldown overrides and never overrides off", () => {
    expect(
      resolveProactiveGateConfig({
        ELIZA_PROACTIVE_INTERACTIONS: "chatty",
        ELIZA_PROACTIVE_INTERACTIONS_TEST_COOLDOWN_MS: "not-a-number",
      }).globalCooldownMs,
    ).toBe(configForChattiness("chatty").globalCooldownMs);

    const off = resolveProactiveGateConfig({
      ELIZA_PROACTIVE_INTERACTIONS: "off",
      ELIZA_PROACTIVE_INTERACTIONS_TEST_COOLDOWN_MS: "5000",
    });
    expect(off.chattiness).toBe("off");
    expect(off.globalCooldownMs).toBe(Number.POSITIVE_INFINITY);
  });
});
