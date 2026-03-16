import { describe, expect, test } from "vitest";
import doctorScript from "../../shared/doctor.json";
import type { ElizaDoctorJson } from "../types";

const script = doctorScript as ElizaDoctorJson;

function allKeywords(scriptData: ElizaDoctorJson): Set<string> {
  const s = new Set<string>();
  for (const k of scriptData.keywords) {
    for (const w of k.keyword) s.add(w.toLowerCase());
  }
  return s;
}

describe("doctor.json validation", () => {
  test("has required top-level fields", () => {
    expect(Array.isArray(script.greetings)).toBe(true);
    expect(Array.isArray(script.goodbyes)).toBe(true);
    expect(Array.isArray(script.default)).toBe(true);
    expect(script.greetings.length).toBeGreaterThan(0);
    expect(script.goodbyes.length).toBeGreaterThan(0);
    expect(script.default.length).toBeGreaterThan(0);
    expect(typeof script.reflections).toBe("object");
    expect(typeof script.groups).toBe("object");
    expect(Array.isArray(script.keywords)).toBe(true);
    expect(script.keywords.length).toBeGreaterThan(0);
  });

  test("covers the full CACM DOCTOR keyword set (keywords + substitutions)", () => {
    const kw = allKeywords(script);
    const subs = script.substitutions ?? {};

    // Keywords (script transformation rules / links)
    const expectedKeywords = [
      "sorry",
      "remember",
      "if",
      "dreamt",
      "dreamed",
      "dream",
      "dreams",
      "perhaps",
      "maybe",
      "name",
      "xfremd",
      "deutsch",
      "français",
      "italiano",
      "español",
      "hello",
      "computer",
      "machine",
      "machines",
      "computers",
      "am",
      "are",
      "your",
      "was",
      "were",
      "you're",
      "i'm",
      "i",
      "you",
      "yes",
      "certainly",
      "no",
      "my",
      "can",
      "what",
      "how",
      "when",
      "because",
      "why",
      "everyone",
      "everybody",
      "nobody",
      "noone",
      "always",
      "like",
      "dit",
      "alike",
      "same",
    ];

    const missingKeywords = expectedKeywords.filter((k) => !kw.has(k));
    expect(missingKeywords).toEqual([]);

    // Substitution-only rules present in the CACM appendix (e.g. DONT=CANT=WONT, ME=YOU, etc.)
    const expectedSubstitutions = ["dont", "cant", "wont", "me", "mom", "dad"];
    const missingSubs = expectedSubstitutions.filter((k) => !(k in subs));
    expect(missingSubs).toEqual([]);

    // DLIST tag sets are represented as groups.
    expect(script.groups.belief).toEqual(["feel", "think", "believe", "wish"]);
    expect(script.groups.family.length).toBeGreaterThan(0);
  });

  test("all redirect targets exist as keywords", () => {
    const kw = allKeywords(script);
    const redirects: string[] = [];

    for (const entry of script.keywords) {
      for (const rule of entry.rules) {
        for (const r of rule.reassembly) {
          const trimmed = r.trim();
          if (!trimmed.startsWith("=")) continue;
          const target = trimmed.slice(1).trim().toLowerCase();
          if (target.length > 0) redirects.push(target);
        }
      }
    }

    const missing = redirects.filter((t) => !kw.has(t));
    expect(missing).toEqual([]);
  });

  test("all @group references exist", () => {
    const missingGroups: string[] = [];

    for (const entry of script.keywords) {
      for (const rule of entry.rules) {
        const matches = rule.decomposition.match(/@([a-z0-9_-]+)/gi) ?? [];
        for (const m of matches) {
          const group = m.slice(1).toLowerCase();
          if (!(group in script.groups)) missingGroups.push(group);
        }
      }
    }

    expect(missingGroups).toEqual([]);
  });
});
