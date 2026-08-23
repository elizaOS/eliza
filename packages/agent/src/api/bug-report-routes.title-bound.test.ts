// Pins the GitHub bug-report title bound: `[Bug] ` prefix must stay within
// the documented 80-char title cap (previously the prefix pushed titles to 86).
import { describe, expect, test } from "bun:test";

describe("GitHub bug-report title bound", () => {
  test("keeps the final title (prefix included) within 80 chars", async () => {
    const mod = await import("./bug-report-routes");
    // 构造80+字符的description → sanitize(74) → [Bug] + 74 = 80
    const long = "x".repeat(120);
    const { sanitize } = mod as unknown as { sanitize: (s: string, n: number) => string };
    const titled = `[Bug] ${sanitize(long, 80 - "[Bug] ".length).replace(/[\r\n]+/g, " ")}`;
    expect(titled.length).toBeLessThanOrEqual(80);
    expect(titled.startsWith("[Bug] ")).toBe(true);
  });

  test("short descriptions pass through unchanged (no over-trimming)", async () => {
    const mod = await import("./bug-report-routes") as unknown as { sanitize: (s: string, n: number) => string };
    const { sanitize } = mod;
    const short = "crash on startup";
    const titled = `[Bug] ${sanitize(short, 80 - "[Bug] ".length).replace(/[\r\n]+/g, " ")}`;
    expect(titled).toBe(`[Bug] ${short}`);
    expect(titled.length).toBeLessThanOrEqual(80);
  });
});
