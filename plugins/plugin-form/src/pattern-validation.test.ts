/**
 * Exercises both production form-pattern hosts against the shared bounded
 * regex dialect, including a child-process deadline for adversarial patterns.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getBuiltinType } from "./builtins";
import type { FormControl } from "./types";
import { validateField } from "./validation";

const textType = getBuiltinType("text");
if (!textType?.validate) throw new Error("built-in text validator unavailable");

function results(pattern: string, value: string): [boolean, boolean] {
  const control: FormControl = {
    key: "code",
    label: "Code",
    type: "text",
    pattern,
  };
  return [
    validateField(value, control).valid,
    textType.validate(value, control).valid,
  ];
}

describe("agent-authored form patterns", () => {
  it.each([
    [String.raw`^\d+$`, "12345", true],
    [String.raw`^\d+$`, "12a", false],
    [String.raw`^[A-Z]{3}-\d{4}$`, "ABC-1234", true],
    ["^[a-z0-9_-]{1,32}$", "agent_7-prod", true],
    [String.raw`^a\.b\+$`, "a.b+", true],
    [String.raw`^[^\s]{2,8}$`, "x-y", true],
  ])("preserves supported pattern %s", (pattern, value, expected) => {
    expect(results(pattern, value)).toEqual([expected, expected]);
  });

  it.each([
    ["("],
    ["^(a+)+$"],
    ["^(a|aa)+$"],
    ["^a+b+$"],
    ["^(?=a)a$"],
    [String.raw`^(a)\1$`],
  ])(
    "fails unsupported or malformed pattern %s as invalid format",
    (pattern) => {
      const value = `${"a".repeat(64)}!`;
      const control: FormControl = {
        key: "code",
        label: "Code",
        type: "text",
        pattern,
      };
      expect(() => results(pattern, value)).not.toThrow();
      expect(validateField(value, control)).toEqual({
        valid: false,
        error: "Code has invalid format",
      });
      expect(textType.validate?.(value, control)).toEqual({
        valid: false,
        error: "Invalid format",
      });
    },
  );

  it("enforces the exact shared pattern and subject ceilings", () => {
    const exactPattern = `^${"a".repeat(198)}$`;
    expect(exactPattern).toHaveLength(200);
    expect(results(exactPattern, "a".repeat(198))).toEqual([true, true]);
    expect(results(`${exactPattern}a`, "a".repeat(199))).toEqual([
      false,
      false,
    ]);

    expect(results("^a+$", "a".repeat(4_096))).toEqual([true, true]);
    expect(results("^a+$", "a".repeat(4_097))).toEqual([false, false]);
  });

  it("keeps both production hosts within a hard child-process deadline", () => {
    const validationUrl = new URL("./validation.ts", import.meta.url).href;
    const builtinsUrl = new URL("./builtins.ts", import.meta.url).href;
    const script = `
      const [{ validateField }, { getBuiltinType }] = await Promise.all([
        import(${JSON.stringify(validationUrl)}),
        import(${JSON.stringify(builtinsUrl)})
      ]);
      const text = getBuiltinType("text");
      const value = "a".repeat(48) + "!";
      for (const pattern of ["^(a+)+$", "^(a|aa)+$"]) {
        const control = { key: "code", label: "Code", type: "text", pattern };
        if (validateField(value, control).valid) process.exit(2);
        if (text.validate(value, control).valid) process.exit(3);
      }
      console.log("bounded");
    `;

    const output = execFileSync(
      "bun",
      ["--conditions=eliza-source", "--eval", script],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { PATH: process.env.PATH ?? "" },
      },
    );
    expect(output.trim()).toBe("bounded");
  });
});
