import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  assertReviewedAppleStoreEntitlements,
  validateEntitlementsAgainstTarget,
} from "./apple-entitlement-audit.ts";

describe("apple entitlement audit", () => {
  it("accepts the reviewed App Store entitlement sources", () => {
    assert.doesNotThrow(() => assertReviewedAppleStoreEntitlements());
  });

  it("flags an unexpected review-sensitive entitlement", () => {
    const manifest = {
      targets: [
        {
          id: "ios-app",
          allowedEntitlements: {
            "com.apple.security.app-sandbox": {
              value: true,
              justification: "App sandbox is required.",
            },
          },
        },
      ],
    };

    const errors = validateEntitlementsAgainstTarget({
      entitlements: {
        "com.apple.security.app-sandbox": true,
        "com.apple.security.cs.disable-library-validation": true,
      },
      targetId: "ios-app",
      manifest,
      label: "fixture",
    });

    assert.ok(
      errors.some((error) =>
        error.includes(
          "unexpected entitlement com.apple.security.cs.disable-library-validation (review-sensitive)",
        ),
      ),
      errors.join("\n"),
    );
  });
});
