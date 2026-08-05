/** Verifies API listen deduplication without hiding unrelated startup output. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isRedundantApiListenLine } from "./dev-ui-log-filter.mjs";

describe("isRedundantApiListenLine", () => {
  it("matches console and structured copies of the upstream listen event", () => {
    assert.equal(
      isRedundantApiListenLine(
        "[eliza-api] Listening on http://127.0.0.1:31337",
      ),
      true,
    );
    assert.equal(
      isRedundantApiListenLine(
        " Info       [eliza-api] Listening on http://127.0.0.1:31337",
      ),
      true,
    );
  });

  it("preserves the compact app-core ready line and unrelated API logs", () => {
    assert.equal(
      isRedundantApiListenLine(
        "[eliza] API ready: http://localhost:31337 (462ms)",
      ),
      false,
    );
    assert.equal(
      isRedundantApiListenLine(
        " Info [eliza-api] upstreamStartApiServer took 103ms",
      ),
      false,
    );
  });
});
