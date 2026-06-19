import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBrandConfig, resetBrandConfigForTests } from "./brand-config";

describe("desktop brand config", () => {
  const originalBrandConfigPath = process.env.ELIZA_BRAND_CONFIG_PATH;
  const originalNamespace = process.env.ELIZA_NAMESPACE;

  afterEach(() => {
    if (originalBrandConfigPath === undefined) {
      delete process.env.ELIZA_BRAND_CONFIG_PATH;
    } else {
      process.env.ELIZA_BRAND_CONFIG_PATH = originalBrandConfigPath;
    }
    if (originalNamespace === undefined) {
      delete process.env.ELIZA_NAMESPACE;
    } else {
      process.env.ELIZA_NAMESPACE = originalNamespace;
    }
    resetBrandConfigForTests();
  });

  it("does not let the shared eliza namespace default override a packaged brand file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brand-config-"));
    const file = path.join(dir, "brand-config.json");
    fs.writeFileSync(
      file,
      `${JSON.stringify({ appName: "Milady", namespace: "milady" })}\n`,
    );

    process.env.ELIZA_BRAND_CONFIG_PATH = file;
    process.env.ELIZA_NAMESPACE = "eliza";
    resetBrandConfigForTests();

    expect(getBrandConfig().namespace).toBe("milady");
  });
});
