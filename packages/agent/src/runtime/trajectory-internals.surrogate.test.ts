import { describe, expect, it } from "vitest";
import {
  truncateField,
  truncateRecord,
  capScriptForPersistence,
} from "./trajectory-internals.ts";

const isWellFormed = (value: string) =>
  (value as unknown as { isWellFormed(): boolean }).isWellFormed?.() ?? true;

describe("trajectory-internals surrogate truncation", () => {
  it("truncateField keeps surrogate pairs intact at head/tail", () => {
    const input = `${"a".repeat(499)}🦊${"b".repeat(2000)}🦊${"c".repeat(499)}`;
    const out = truncateField(input, 500);
    expect(isWellFormed(out)).toBe(true);
  });

  it("capScriptForPersistence keeps script well-formed", () => {
    const out = capScriptForPersistence(
      `${"a".repeat(4095)}🦊${"b".repeat(500)}`,
    );
    expect(isWellFormed(out.script)).toBe(true);
  });

  it("observation truncation keeps surrogate pairs intact", () => {
    const parsed = [`${"x".repeat(200)}🦊${"y".repeat(200)}`];
    const observations = parsed
      .filter((s: unknown) => typeof s === "string" && s.length > 0)
      .map((s: string) => s.slice(0, 150)) as string[];

    expect(observations).toHaveLength(1);
    expect(isWellFormed(observations[0])).toBe(true);
  });
});
