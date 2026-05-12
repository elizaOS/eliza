/**
 * The DSPy example loader (`buildExamplesFromRows`) routes every JSONL row
 * through the mandatory privacy filter from `core/privacy-filter.ts`. This
 * test injects PII into synthetic `eliza_native_v1` rows and asserts the PII
 * is stripped before the Example reaches the optimizer.
 *
 * The brief calls out "ssn 123-45-6789" specifically — that exact format is
 * not in the live regex set (the filter targets email / phone / address /
 * geo / credentials), so we also inject an email + an explicitly formatted
 * phone number to verify the redaction pipeline runs on this path.
 */

import { describe, expect, it } from "vitest";
import { buildExamplesFromRows } from "../examples.js";

describe("DSPy example loader privacy filter", () => {
  it("strips email + phone PII from system + user + response before exposing examples", () => {
    const rows = [
      {
        format: "eliza_native_v1" as const,
        request: {
          system: "Operator email: alice@example.com",
          messages: [
            {
              role: "user" as const,
              content:
                "my number is (415) 555-0123 and ssn 123-45-6789, please help",
            },
          ],
        },
        response: {
          text: "Got it bob@example.org will follow up at 415-555-9999",
        },
      },
    ];

    const result = buildExamplesFromRows(rows);
    expect(result.examples).toHaveLength(1);
    const example = result.examples[0];
    if (!example) throw new Error("expected one example");

    const systemPrompt = String(example.inputs.system ?? "");
    const userPrompt = String(example.inputs.input ?? "");
    const expected = String(example.outputs.output ?? "");

    // Email: redacted in system + response.
    expect(systemPrompt).not.toContain("alice@example.com");
    expect(systemPrompt).toContain("[REDACTED_EMAIL]");
    expect(expected).not.toContain("bob@example.org");
    expect(expected).toContain("[REDACTED_EMAIL]");

    // Phone (NANP with explicit separators): redacted.
    expect(userPrompt).not.toContain("(415) 555-0123");
    expect(userPrompt).toContain("[REDACTED_PHONE]");
    expect(expected).not.toContain("415-555-9999");
    expect(expected).toContain("[REDACTED_PHONE]");

    // The redaction counter is non-zero — proof the filter actually ran
    // on this pipeline (a regression where the loader bypasses the filter
    // would land here with zero).
    expect(result.redactionCount).toBeGreaterThan(0);
  });
});
