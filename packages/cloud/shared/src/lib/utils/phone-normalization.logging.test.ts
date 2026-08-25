/** Proves phone normalization emits only constant diagnostics for malformed input. */

import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "./logger";
import { normalizePhoneNumber } from "./phone-normalization";

describe("phone normalization logging", () => {
  test("excludes the input and parser error details", () => {
    const sentinel = "SENTINEL_PHONE_PARSE_INPUT";
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined as never);

    expect(normalizePhoneNumber(sentinel)).toBe("");

    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).toContain('"errorClass":"phone_parse_failed"');
    expect(serialized).not.toContain(sentinel);
    warn.mockRestore();
  });
});
