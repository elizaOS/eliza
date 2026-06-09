import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import {
  assertMasEntitlementRuntimeEvidence,
  assertReviewedAppleStoreEntitlements,
  scanAppleAppBundleForNativeRuntimeSignals,
  validateEntitlementsAgainstTarget,
} from "./apple-entitlement-audit.mjs";

describe("apple entitlement audit", () => {
  it("accepts the reviewed App Store entitlement sources", () => {
    assert.doesNotThrow(() => assertReviewedAppleStoreEntitlements());
  });

  it("flags MAS allow-unsigned-executable-memory without current evidence", () => {
    const manifest = {
      targets: [
        {
          id: "macos-mas-app",
          distribution: "mac-app-store",
          allowedEntitlements: {
            "com.apple.security.app-sandbox": {
              value: true,
              justification: "Mac App Store sandbox is required.",
            },
            "com.apple.security.cs.allow-unsigned-executable-memory": {
              value: true,
              reviewSensitive: true,
              appReviewJustification:
                "Temporary runtime exception that must be backed by current evidence.",
            },
          },
        },
      ],
    };

    const errors = validateEntitlementsAgainstTarget({
      entitlements: {
        "com.apple.security.app-sandbox": true,
        "com.apple.security.cs.allow-unsigned-executable-memory": true,
      },
      targetId: "macos-mas-app",
      manifest,
      label: "fixture",
    });

    assert.ok(
      errors.some((error) => error.includes("needs currentEvidence")),
      errors.join("\n"),
    );
  });

  it("flags unexpected MAS disable-library-validation as review-sensitive", () => {
    const manifest = {
      targets: [
        {
          id: "macos-mas-app",
          distribution: "mac-app-store",
          allowedEntitlements: {
            "com.apple.security.app-sandbox": {
              value: true,
              justification: "Mac App Store sandbox is required.",
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
      targetId: "macos-mas-app",
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

  it("scans a built app bundle for JIT and native-library signals", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "apple-entitlement-audit-"));
    try {
      const app = path.join(tmp, "Fixture.app");
      const macos = path.join(app, "Contents", "MacOS");
      mkdirSync(macos, { recursive: true });
      writeFileSync(
        path.join(macos, "bun"),
        Buffer.concat([
          Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
          Buffer.from(
            "\0_pthread_jit_write_protect_np\0_MAP_JIT\0_dlopen\0libNativeWrapper.dylib\0",
          ),
        ]),
      );

      const scan = scanAppleAppBundleForNativeRuntimeSignals(app);

      assert.equal(scan.machOCount, 1);
      assert.equal(scan.jitExecutableMemory.length, 1);
      assert.ok(scan.dynamicLibraryLoading.length >= 1);
      assert.doesNotThrow(() =>
        assertMasEntitlementRuntimeEvidence({
          entitlements: {
            "com.apple.security.cs.allow-jit": true,
          },
          scan,
          label: "fixture",
        }),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("requires built-app evidence when a MAS JIT entitlement is present", () => {
    assert.throws(
      () =>
        assertMasEntitlementRuntimeEvidence({
          entitlements: {
            "com.apple.security.cs.allow-jit": true,
          },
          scan: {
            jitExecutableMemory: [],
            dynamicLibraryLoading: [],
          },
          label: "fixture",
        }),
      /no JIT or executable-memory native-symbol evidence/,
    );
  });
});
