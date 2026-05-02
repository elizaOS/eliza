import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  downloadsStagingDir,
  isWithinElizaRoot,
  localInferenceRoot,
  elizaModelsDir,
  registryPath,
} from "./paths";

describe("paths", () => {
  let originalElizaStateDir: string | undefined;

  beforeEach(() => {
    originalElizaStateDir = process.env.ELIZA_STATE_DIR;
  });

  afterEach(() => {
    if (originalElizaStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = originalElizaStateDir;
    }
  });

  it("uses ELIZA_STATE_DIR when set", () => {
    process.env.ELIZA_STATE_DIR = "/eliza/state";
    expect(localInferenceRoot()).toBe(
      path.join("/eliza/state", "local-inference"),
    );
    expect(elizaModelsDir()).toBe(
      path.join("/eliza/state", "local-inference", "models"),
    );
    expect(downloadsStagingDir()).toBe(
      path.join("/eliza/state", "local-inference", "downloads"),
    );
    expect(registryPath()).toBe(
      path.join("/eliza/state", "local-inference", "registry.json"),
    );
  });

  it("falls back to ~/.eliza/local-inference when ELIZA_STATE_DIR is unset", () => {
    delete process.env.ELIZA_STATE_DIR;
    expect(localInferenceRoot()).toBe(
      path.join(os.homedir(), ".eliza", "local-inference"),
    );
  });

  it("isWithinElizaRoot rejects the root itself and external paths", () => {
    process.env.ELIZA_STATE_DIR = "/state";
    const root = path.join("/state", "local-inference");
    expect(isWithinElizaRoot(root)).toBe(false);
    expect(isWithinElizaRoot(path.join(root, "models", "x.gguf"))).toBe(true);
    expect(isWithinElizaRoot("/etc/passwd")).toBe(false);
    expect(isWithinElizaRoot(`${root}-evil`)).toBe(false);
  });
});
