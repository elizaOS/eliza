/**
 * Regression for skills formatter surrogate-safe truncation.
 */

import { describe, expect, it } from "vitest";
import { buildSkillCommandSpecs } from "./formatter";
import type { SkillEntry } from "./types";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function makeEntry(name: string): SkillEntry {
  return {
    skill: { name, description: name } as any,
    invocation: { userInvocable: true },
    frontmatter: {},
    filePath: "SKILL.md",
  } as unknown as SkillEntry;
}

describe("formatter surrogate-safe", () => {
  it("keeps surrogate pairs intact at 1024 boundary before sanitizing", () => {
    const name = `${"a".repeat(1023)}🦊${"b".repeat(50)}`;
    const [spec] = buildSkillCommandSpecs([makeEntry(name)]);
    expect(spec).toBeDefined();
    expect(isWellFormed(spec.name)).toBe(true);
    expect(spec.name.length).toBeLessThanOrEqual(32);
  });

  it("keeps 32-char command boundary well-formed", () => {
    const name = `${"a".repeat(31)}🦊${"b".repeat(50)}`;
    const [spec] = buildSkillCommandSpecs([makeEntry(name)]);
    expect(spec).toBeDefined();
    expect(isWellFormed(spec.name)).toBe(true);
    expect(spec.name.length).toBeLessThanOrEqual(32);
  });

  it("handles maxBaseLength with suffix well-formed", () => {
    const baseName = "a".repeat(32);
    const entries = [makeEntry(baseName), makeEntry(baseName)];
    const specs = buildSkillCommandSpecs(entries);
    expect(specs[1].name).toBe(`${"a".repeat(30)}_1`);
    expect(isWellFormed(specs[1].name)).toBe(true);
  });

  it("sanitizes lone surrogates in name", () => {
    const name = `skill \uD800 test`;
    const [spec] = buildSkillCommandSpecs([makeEntry(name)]);
    expect(spec).toBeDefined();
    expect(isWellFormed(spec.name)).toBe(true);
    expect(spec.name).not.toContain("\uD800");
  });
});
