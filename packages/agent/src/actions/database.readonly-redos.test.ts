/**
 * Covers the DATABASE action's read-only SQL guard on adversarial input. The
 * guard receives model-produced SQL, so comment and dollar-quote stripping must
 * be linear and must leave malformed SQL visible to the mutation scanner.
 */
import { describe, expect, it } from "vitest";

import { checkReadOnly } from "./database.ts";

describe("DATABASE read-only SQL guard", () => {
  it("rejects mutation keywords split by block comments", () => {
    const result = checkReadOnly("DE/* invisible */LETE FROM memories");

    expect(result).toEqual({
      ok: false,
      reason:
        '"DELETE" is a mutation keyword. Set allowWrites:true to execute mutations.',
    });
  });

  it("rejects mutation keywords in unterminated dollar-quoted input quickly", () => {
    const sql = `${Array.from({ length: 50_000 }, (_, i) => `$tag${i}$x`).join(
      "",
    )} DELETE FROM memories`;

    const start = performance.now();
    const result = checkReadOnly(sql);
    const elapsed = performance.now() - start;

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain('"DELETE"');
    }
    expect(elapsed).toBeLessThan(1000);
  });
});
