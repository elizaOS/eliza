/**
 * Unit coverage for local-inference path resolution helpers in paths.ts.
 *
 * Tests path composition for localInferenceRoot, elizaModelsDir, registryPath,
 * downloadsStagingDir, and isWithinElizaRoot containment predicates.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  downloadsStagingDir,
  elizaModelsDir,
  isWithinElizaRoot,
  localInferenceRoot,
  registryPath,
} from "./paths.js";

describe("local-inference paths", () => {
  it("resolves localInferenceRoot ending with local-inference", () => {
    const root = localInferenceRoot();
    expect(typeof root).toBe("string");
    expect(root.endsWith("local-inference")).toBe(true);
  });

  it("resolves model directory inside local-inference root", () => {
    const models = elizaModelsDir();
    expect(models).toBe(path.join(localInferenceRoot(), "models"));
  });

  it("resolves registry JSON path inside local-inference root", () => {
    const registry = registryPath();
    expect(registry).toBe(path.join(localInferenceRoot(), "registry.json"));
  });

  it("resolves downloads staging directory inside local-inference root", () => {
    const staging = downloadsStagingDir();
    expect(staging).toBe(path.join(localInferenceRoot(), "downloads"));
  });

  describe("isWithinElizaRoot", () => {
    it("returns true for subpaths strictly inside localInferenceRoot", () => {
      const insideFile = path.join(
        localInferenceRoot(),
        "models",
        "model.gguf",
      );
      const insideDir = path.join(localInferenceRoot(), "downloads", "partial");
      expect(isWithinElizaRoot(insideFile)).toBe(true);
      expect(isWithinElizaRoot(insideDir)).toBe(true);
    });

    it("returns false for the root directory itself", () => {
      expect(isWithinElizaRoot(localInferenceRoot())).toBe(false);
    });

    it("returns false for external paths and sibling directories", () => {
      expect(isWithinElizaRoot("/tmp/other-path")).toBe(false);
      expect(
        isWithinElizaRoot(path.join(localInferenceRoot(), "..", "sibling")),
      ).toBe(false);
    });
  });
});
