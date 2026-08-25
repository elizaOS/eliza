/**
 * Unit coverage for typed evidence pipeline errors in errors.ts.
 *
 * Exercises EvidenceError and EvidenceValidationError across code tagging,
 * context dictionaries, cause propagation, prototype chain integrity,
 * and schema issue tracking.
 */

import { describe, expect, it } from "vitest";
import {
  EvidenceError,
  EvidenceValidationError,
  type ValidationIssue,
} from "./errors.js";

describe("errors", () => {
  describe("EvidenceError", () => {
    it("instantiates with message, code, and context", () => {
      const err = new EvidenceError("Manifest missing", {
        code: "MANIFEST_NOT_FOUND",
        context: { bundleId: "bundle-123" },
      });

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(EvidenceError);
      expect(err.name).toBe("EvidenceError");
      expect(err.message).toBe("Manifest missing");
      expect(err.code).toBe("MANIFEST_NOT_FOUND");
      expect(err.context).toEqual({ bundleId: "bundle-123" });
    });

    it("preserves underlying cause when provided", () => {
      const rootCause = new Error("Disk read failure");
      const err = new EvidenceError("Failed to load evidence bundle", {
        code: "BUNDLE_READ_FAILED",
        cause: rootCause,
      });

      expect(err.cause).toBe(rootCause);
    });
  });

  describe("EvidenceValidationError", () => {
    it("instantiates with validation issues and maintains prototype hierarchy", () => {
      const issues: ValidationIssue[] = [
        { path: "artifacts.0.sha256", message: "Invalid hex hash format" },
        { path: "timestamp", message: "Must be a finite epoch timestamp" },
      ];

      const err = new EvidenceValidationError(
        "Manifest validation failed",
        issues,
        {
          code: "MANIFEST_INVALID",
          context: { path: "/evidence/manifest.json" },
        },
      );

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(EvidenceError);
      expect(err).toBeInstanceOf(EvidenceValidationError);
      expect(err.name).toBe("EvidenceValidationError");
      expect(err.message).toBe("Manifest validation failed");
      expect(err.code).toBe("MANIFEST_INVALID");
      expect(err.issues).toEqual(issues);
      expect(err.issues.length).toBe(2);
      expect(err.context).toEqual({ path: "/evidence/manifest.json" });
    });
  });
});
