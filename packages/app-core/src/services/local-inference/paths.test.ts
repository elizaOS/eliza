import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  downloadsStagingDir,
  isWithinMiladyRoot,
  localInferenceRoot,
  miladyModelsDir,
  registryPath,
} from "./paths";

describe("paths", () => {
  let originalMiladyStateDir: string | undefined;
  let originalElizaStateDir: string | undefined;

  beforeEach(() => {
    originalMiladyStateDir = process.env.MILADY_STATE_DIR;
    originalElizaStateDir = process.env.ELIZA_STATE_DIR;
  });

  afterEach(() => {
    if (originalMiladyStateDir === undefined) {
      delete process.env.MILADY_STATE_DIR;
    } else {
      process.env.MILADY_STATE_DIR = originalMiladyStateDir;
    }
    if (originalElizaStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = originalElizaStateDir;
    }
  });

  it("uses MILADY_STATE_DIR when set", () => {
    process.env.MILADY_STATE_DIR = "/milady/state";
    delete process.env.ELIZA_STATE_DIR;
    expect(localInferenceRoot()).toBe(
      path.join("/milady/state", "local-inference"),
    );
    expect(miladyModelsDir()).toBe(
      path.join("/milady/state", "local-inference", "models"),
    );
    expect(downloadsStagingDir()).toBe(
      path.join("/milady/state", "local-inference", "downloads"),
    );
    expect(registryPath()).toBe(
      path.join("/milady/state", "local-inference", "registry.json"),
    );
  });

  it("uses ELIZA_STATE_DIR when MILADY_STATE_DIR is unset", () => {
    delete process.env.MILADY_STATE_DIR;
    process.env.ELIZA_STATE_DIR = "/custom/state";
    expect(localInferenceRoot()).toBe(
      path.join("/custom/state", "local-inference"),
    );
    expect(miladyModelsDir()).toBe(
      path.join("/custom/state", "local-inference", "models"),
    );
  });

  it("MILADY_STATE_DIR wins over ELIZA_STATE_DIR when both set", () => {
    process.env.MILADY_STATE_DIR = "/milady/state";
    process.env.ELIZA_STATE_DIR = "/eliza/state";
    expect(localInferenceRoot()).toBe(
      path.join("/milady/state", "local-inference"),
    );
  });

  it("falls back to ~/.eliza/local-inference when both unset", () => {
    delete process.env.MILADY_STATE_DIR;
    delete process.env.ELIZA_STATE_DIR;
    expect(localInferenceRoot()).toBe(
      path.join(os.homedir(), ".eliza", "local-inference"),
    );
  });

  it("isWithinMiladyRoot rejects the root itself and external paths", () => {
    delete process.env.MILADY_STATE_DIR;
    process.env.ELIZA_STATE_DIR = "/state";
    const root = path.join("/state", "local-inference");
    expect(isWithinMiladyRoot(root)).toBe(false);
    expect(isWithinMiladyRoot(path.join(root, "models", "x.gguf"))).toBe(true);
    expect(isWithinMiladyRoot("/etc/passwd")).toBe(false);
    expect(isWithinMiladyRoot(`${root}-evil`)).toBe(false);
  });
});
