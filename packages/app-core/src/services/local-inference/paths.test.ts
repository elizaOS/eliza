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
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.ELIZA_STATE_DIR;
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = originalStateDir;
    }
  });

  it("uses ELIZA_STATE_DIR when set", () => {
    process.env.ELIZA_STATE_DIR = "/custom/state";
    expect(localInferenceRoot()).toBe(
      path.join("/custom/state", "local-inference"),
    );
    expect(miladyModelsDir()).toBe(
      path.join("/custom/state", "local-inference", "models"),
    );
    expect(downloadsStagingDir()).toBe(
      path.join("/custom/state", "local-inference", "downloads"),
    );
    expect(registryPath()).toBe(
      path.join("/custom/state", "local-inference", "registry.json"),
    );
  });

  it("falls back to ~/.eliza/local-inference when unset", () => {
    delete process.env.ELIZA_STATE_DIR;
    expect(localInferenceRoot()).toBe(
      path.join(os.homedir(), ".eliza", "local-inference"),
    );
  });

  it("isWithinMiladyRoot rejects the root itself and external paths", () => {
    process.env.ELIZA_STATE_DIR = "/state";
    const root = path.join("/state", "local-inference");
    expect(isWithinMiladyRoot(root)).toBe(false);
    expect(
      isWithinMiladyRoot(path.join(root, "models", "x.gguf")),
    ).toBe(true);
    expect(isWithinMiladyRoot("/etc/passwd")).toBe(false);
    expect(isWithinMiladyRoot(`${root}-evil`)).toBe(false);
  });
});
