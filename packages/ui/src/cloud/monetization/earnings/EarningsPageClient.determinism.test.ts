/** Guards the earnings quote's no-quote render and invalidation boundaries. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./EarningsPageClient.tsx", import.meta.url),
  "utf8",
);

describe("EarningsPageClient quote-clock determinism", () => {
  it("uses a deterministic sentinel until the first quote arrives", () => {
    expect(source).toMatch(
      /const \[quoteClock, setQuoteClock\] = useState\(0\);/,
    );
  });

  it("does not read wall time while invalidating an absent quote", () => {
    const invalidateQuote = source.match(
      /const invalidateQuote = \(\) => \{([\s\S]*?)\n {2}\};/,
    )?.[1];

    expect(invalidateQuote).toBeDefined();
    expect(invalidateQuote).not.toMatch(/Date\.|new Date\s*\(/);
  });
});
