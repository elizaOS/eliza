/** Verifies API listen deduplication without hiding unrelated startup output. */
import { describe, expect, it } from "vitest";

import { isRedundantApiListenLine } from "./dev-ui-log-filter.mjs";

describe("isRedundantApiListenLine", () => {
  it("matches console and structured copies of the upstream listen event", () => {
    expect(
      isRedundantApiListenLine(
        "[eliza-api] Listening on http://127.0.0.1:31337",
      ),
    ).toBe(true);
    expect(
      isRedundantApiListenLine(
        " Info       [eliza-api] Listening on http://127.0.0.1:31337",
      ),
    ).toBe(true);
  });

  it("preserves the compact app-core ready line and unrelated API logs", () => {
    expect(
      isRedundantApiListenLine(
        "[eliza] API ready: http://localhost:31337 (462ms)",
      ),
    ).toBe(false);
    expect(
      isRedundantApiListenLine(
        " Info [eliza-api] upstreamStartApiServer took 103ms",
      ),
    ).toBe(false);
  });
});
