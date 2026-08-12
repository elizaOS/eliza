import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parsePositiveSafeInteger,
  resolveStaleAfterMs,
} from "../with-package-build-lock.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(
  __dirname,
  "../with-package-build-lock.mjs",
);

describe("with-package-build-lock ELIZA_PACKAGE_BUILD_LOCK_STALE_MS validation", () => {
  it("uses default 1800000 ms when env var is unset or empty", () => {
    assert.equal(resolveStaleAfterMs(undefined), 1800000);
    assert.equal(resolveStaleAfterMs(""), 1800000);
  });

  it("parses valid positive safe integers", () => {
    assert.equal(resolveStaleAfterMs("1800000"), 1800000);
    assert.equal(resolveStaleAfterMs("600000"), 600000);
    assert.equal(resolveStaleAfterMs("1"), 1);
  });

  it("rejects malformed, non-numeric, signed, fractional, zero, and negative inputs", () => {
    const invalidInputs = [
      "1800000junk",
      "invalid",
      "1800000.5",
      "+1800000",
      "0",
      "-500",
      "  ",
    ];

    for (const input of invalidInputs) {
      assert.throws(
        () => resolveStaleAfterMs(input),
        (err) => {
          assert.match(
            err.message,
            /\[with-package-build-lock\] ELIZA_PACKAGE_BUILD_LOCK_STALE_MS must be a positive safe-integer decimal/,
          );
          return true;
        },
        `Expected input "${input}" to throw validation error`,
      );
    }
  });

  it("fails closed in CLI subprocess execution when ELIZA_PACKAGE_BUILD_LOCK_STALE_MS is malformed", () => {
    assert.throws(
      () => {
        execFileSync(
          process.execPath,
          [scriptPath, "packages/core", "--", "echo", "hello"],
          {
            env: {
              ...process.env,
              ELIZA_PACKAGE_BUILD_LOCK_STALE_MS: "1800000junk",
            },
            encoding: "utf8",
            stdio: "pipe",
          },
        );
      },
      (err) => {
        assert.equal(err.status, 1);
        assert.match(
          err.stderr,
          /\[with-package-build-lock\] ELIZA_PACKAGE_BUILD_LOCK_STALE_MS must be a positive safe-integer decimal/,
        );
        return true;
      },
    );
  });

  it("prints usage and exits 1 when CLI arguments are incomplete", () => {
    assert.throws(
      () => {
        execFileSync(process.execPath, [scriptPath, "--help"], {
          env: process.env,
          encoding: "utf8",
          stdio: "pipe",
        });
      },
      (err) => {
        assert.equal(err.status, 1);
        assert.match(
          err.stderr,
          /Usage: node packages\/scripts\/with-package-build-lock.mjs/,
        );
        return true;
      },
    );
  });
});
