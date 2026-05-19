import { describe, expect, it } from "vitest";
import { sanitizePlannerText } from "../../src/index.js";

const SELF_HEAL =
  "(Sub-agent state self-heals; respawning a fresh one automatically.)";

describe("sanitizePlannerText", () => {
  it("passes through empty input unchanged", () => {
    expect(sanitizePlannerText("")).toBe("");
  });

  it("passes through clean text unchanged", () => {
    const text = "Editing locales/fr.json and running build.";
    expect(sanitizePlannerText(text)).toBe(text);
  });

  it("strips 'restart acpx' sentences and appends self-heal note", () => {
    const out = sanitizePlannerText("Please restart acpx to recover.");
    expect(out).toBe(SELF_HEAL);
  });

  it("strips 'clear stale sessions' phrases", () => {
    const out = sanitizePlannerText("You should clear stale sessions now.");
    expect(out).toBe(SELF_HEAL);
  });

  it("strips 'manually clear sessions' phrases", () => {
    const out = sanitizePlannerText("Manually clear sessions, then retry.");
    expect(out).toBe(SELF_HEAL);
  });

  it("strips daemon-restart phrases", () => {
    const out = sanitizePlannerText("The daemon isn't accepting requests.");
    expect(out).toBe(SELF_HEAL);
  });

  it("strips 'acpx not accepting' phrases", () => {
    const out = sanitizePlannerText("acpx isn't accepting new spawns.");
    expect(out).toBe(SELF_HEAL);
  });

  it("preserves surrounding clean prose and appends note", () => {
    const out = sanitizePlannerText(
      "Working on the locale fix. Please restart acpx to recover. Continuing.",
    );
    expect(out).toContain("Working on the locale fix.");
    expect(out).toContain("Continuing.");
    expect(out.endsWith(SELF_HEAL)).toBe(true);
  });

  it("collapses double spaces left by replacement", () => {
    const out = sanitizePlannerText("Step one. Please restart acpx. Step two.");
    expect(out).not.toMatch(/ {2,}/);
  });

  it("returns just the self-heal note when input is only-forbidden", () => {
    const out = sanitizePlannerText("Restart acpx. Clear stale sessions.");
    expect(out).toBe(SELF_HEAL);
  });

  it("is idempotent across consecutive calls (no lastIndex carry-over)", () => {
    const input = "Please restart acpx to recover.";
    const first = sanitizePlannerText(input);
    const second = sanitizePlannerText(input);
    const third = sanitizePlannerText(input);
    expect(first).toBe(SELF_HEAL);
    expect(second).toBe(SELF_HEAL);
    expect(third).toBe(SELF_HEAL);
  });

  it("preserves emoji and bracket prefixes when nothing matches", () => {
    const text = "💬 [sub-agent: foo] editing styles.css";
    expect(sanitizePlannerText(text)).toBe(text);
  });
});
