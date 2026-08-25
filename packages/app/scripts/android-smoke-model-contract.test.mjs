import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptsDir, "..");
const androidE2e = fs.readFileSync(
  path.join(scriptsDir, "android-e2e.mjs"),
  "utf8",
);
const mobileSmoke = fs.readFileSync(
  path.join(scriptsDir, "mobile-local-chat-smoke.mjs"),
  "utf8",
);
const androidDevice = fs.readFileSync(
  path.join(scriptsDir, "lib", "android-device.mjs"),
  "utf8",
);
const androidReadme = fs.readFileSync(
  path.join(appDir, "test", "android", "README.md"),
  "utf8",
);

const smokeModel = {
  file: "eliza-1-e2b-32k.gguf",
  relativePath: "bundles/e2b/text/eliza-1-e2b-32k.gguf",
  sizeBytes: "1_270_808_512",
  docSizeBytes: "1,270,808,512",
  staleFile: "eliza-1-2b-128k.gguf",
  staleSizeClaim: "~556MB",
};

describe("Android smoke model contract (#13584)", () => {
  it("uses the 32k GGUF in both Android smoke entrypoints", () => {
    expect(androidE2e).toContain(`file: "${smokeModel.file}"`);
    expect(androidE2e).toContain(smokeModel.relativePath);
    expect(mobileSmoke).toContain(`file: "${smokeModel.file}"`);
    expect(mobileSmoke).toContain(`relativePath: "${smokeModel.relativePath}"`);
  });

  it("keeps script and README size guidance on the same artifact", () => {
    for (const source of [androidE2e, mobileSmoke]) {
      expect(source).toContain(`sizeBytes: ${smokeModel.sizeBytes}`);
    }
    for (const source of [androidDevice, androidReadme]) {
      expect(source).toContain(smokeModel.docSizeBytes);
      expect(source).not.toContain(smokeModel.staleSizeClaim);
    }
    expect(androidReadme).toContain(smokeModel.file);
  });

  it("does not leave Android defaults on the old 128k smoke artifact", () => {
    expect(androidE2e).not.toContain(smokeModel.staleFile);
    expect(mobileSmoke).not.toContain(
      `relativePath: "bundles/2b/text/${smokeModel.staleFile}"`,
    );
    expect(mobileSmoke).not.toContain(`file: "${smokeModel.staleFile}"`);
  });
});
