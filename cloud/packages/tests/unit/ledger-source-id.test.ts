import { describe, expect, test } from "bun:test";
import { normalizeLedgerSourceId } from "@/lib/utils/ledger-source-id";

describe("normalizeLedgerSourceId", () => {
  test("preserves valid UUID source IDs", () => {
    expect(normalizeLedgerSourceId("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  test("maps composite source IDs into deterministic UUIDs", () => {
    const sourceId = "revenue_split:pi_123:user_456";
    const normalized = normalizeLedgerSourceId(sourceId);

    expect(normalized).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(normalizeLedgerSourceId(sourceId)).toBe(normalized);
    expect(normalizeLedgerSourceId("revenue_split:pi_999:user_456")).not.toBe(normalized);
  });
});
