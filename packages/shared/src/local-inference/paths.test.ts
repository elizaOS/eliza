/**
 * Tests for local inference root paths and path confinement helpers.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  downloadsStagingDir,
  elizaModelsDir,
  isWithinElizaRoot,
  localInferenceRoot,
  registryPath,
} from "./paths.ts";

describe("local-inference paths", () => {
  it("resolves the local inference root directory", () => {
    const root = localInferenceRoot();
    expect(root).toBeDefined();
    expect(root.endsWith("local-inference")).toBe(true);
  });

  it("resolves specific subdirectories and files relative to root", () => {
    const root = localInferenceRoot();

    expect(elizaModelsDir()).toBe(path.join(root, "models"));
    expect(registryPath()).toBe(path.join(root, "registry.json"));
    expect(downloadsStagingDir()).toBe(path.join(root, "downloads"));
  });

  it("checks whether paths are confined within the Eliza local-inference root", () => {
    const root = localInferenceRoot();
    const modelPath = path.join(root, "models", "eliza-1-9b.gguf");
    const downloadPath = path.join(root, "downloads", "temp-part-001");

    expect(isWithinElizaRoot(modelPath)).toBe(true);
    expect(isWithinElizaRoot(downloadPath)).toBe(true);

    // Exact root itself is not considered "within" (confinement check for sub-items)
    expect(isWithinElizaRoot(root)).toBe(false);

    // External paths and traversal attempts
    expect(isWithinElizaRoot("/etc/passwd")).toBe(false);
    expect(isWithinElizaRoot(path.join(root, "..", "other-dir"))).toBe(false);
    expect(isWithinElizaRoot("")).toBe(false);
    expect(isWithinElizaRoot("   ")).toBe(false);
    expect(isWithinElizaRoot(null)).toBe(false);
    expect(isWithinElizaRoot(undefined)).toBe(false);
  });
});
