/** Exercises safe Personal Shared failure metadata parsing at the HTTP boundary. */

import { describe, expect, test } from "bun:test";
import { readPersonalSharedFailureMetadata } from "./personal-shared-failure";

describe("Personal Shared failure metadata", () => {
  test("keeps only bounded classifications and an explicit retry disposition", () => {
    const metadata = readPersonalSharedFailureMetadata(
      new Response("private provider body", {
        status: 500,
        headers: {
          "Retry-After": "999999",
          "X-Eliza-Failure-Stage": "shared_runtime",
          "X-Eliza-Failure-Name": "SharedRuntimeTurnError",
          "X-Eliza-Failure-Cause-Name": "unsafe value with spaces",
          "X-Eliza-Retryable": "false",
        },
      }),
    );

    expect(metadata).toEqual({
      status: 500,
      stage: "shared_runtime",
      name: "SharedRuntimeTurnError",
      causeName: null,
      retryable: false,
      retryAfterSeconds: 300,
    });
    expect(JSON.stringify(metadata)).not.toContain("private provider body");
  });

  test("rejects malformed retry metadata instead of partially parsing it", () => {
    const metadata = readPersonalSharedFailureMetadata(
      new Response(null, {
        status: 409,
        headers: {
          "Retry-After": "1 second",
          "X-Eliza-Retryable": "TRUE",
        },
      }),
    );

    expect(metadata.retryable).toBe(false);
    expect(metadata.retryAfterSeconds).toBeNull();
  });

  test("rejects safe-looking but unrecognized diagnostic classifications", () => {
    const metadata = readPersonalSharedFailureMetadata(
      new Response("private body", {
        status: 500,
        headers: {
          "X-Eliza-Failure-Stage": "TOP_SECRET_STAGE",
          "X-Eliza-Failure-Name": "PrivateProviderToken",
          "X-Eliza-Failure-Cause-Name": "CustomerIdentifier123",
        },
      }),
    );

    expect(metadata.stage).toBeNull();
    expect(metadata.name).toBeNull();
    expect(metadata.causeName).toBeNull();
  });
});
