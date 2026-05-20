import { describe, expect, test } from "bun:test";

import { isRecoverableComposeStartError } from "../commands/db.js";

describe("db startup recovery", () => {
  test("detects stale Docker network errors as recoverable", () => {
    expect(
      isRecoverableComposeStartError(
        "Error response from daemon: failed to set up container networking: network abc123 not found",
      ),
    ).toBe(true);
  });

  test("ignores unrelated docker-compose failures", () => {
    expect(
      isRecoverableComposeStartError(
        "Error response from daemon: pull access denied for postgres",
      ),
    ).toBe(false);
  });
});
