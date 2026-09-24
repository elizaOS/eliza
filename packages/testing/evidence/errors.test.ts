/** Exercises evidence error classification, preserved causes and validation issues. */
import { expect, it } from "vitest";
import { EvidenceError, EvidenceValidationError } from "./errors.js";

it("preserves classification, context, cause identity and the Error prototype", () => {
  const cause = new Error("Disk read failure");
  const error = new EvidenceError("Failed to load evidence bundle", {
    code: "BUNDLE_READ_FAILED",
    context: { bundleId: "bundle-123" },
    cause,
  });
  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(EvidenceError);
  expect(error).toMatchObject({
    name: "EvidenceError",
    message: "Failed to load evidence bundle",
    code: "BUNDLE_READ_FAILED",
    context: { bundleId: "bundle-123" },
  });
  expect(error.cause).toBe(cause);
});

it("retains every validation issue through the evidence error hierarchy", () => {
  const issues = [
    { path: "artifacts.0.sha256", message: "Invalid hex hash format" },
    { path: "timestamp", message: "Must be a finite epoch timestamp" },
  ];
  const error = new EvidenceValidationError(
    "Manifest validation failed",
    issues,
    {
      code: "MANIFEST_INVALID",
      context: { path: "/evidence/manifest.json" },
    },
  );
  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(EvidenceError);
  expect(error).toBeInstanceOf(EvidenceValidationError);
  expect(error).toMatchObject({
    name: "EvidenceValidationError",
    message: "Manifest validation failed",
    code: "MANIFEST_INVALID",
    context: { path: "/evidence/manifest.json" },
  });
  expect(error.issues).toEqual(issues);
});
