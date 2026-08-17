/**
 * Exercises real cross-browser build output and reproducible archive generation.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBrowserBridgeBuildKind } from "../scripts/build.mjs";
import { createDeterministicWebExtensionArchive } from "../scripts/package-webextension.mjs";
import { resolveSourceDateIso } from "../scripts/release-version.mjs";
import { run } from "../scripts/script-utils.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

type BuiltManifest = {
  manifest_version: number;
  host_permissions: string[];
  optional_host_permissions: string[];
  content_security_policy: { extension_pages: string };
  background: { service_worker?: string; scripts?: string[] };
  browser_specific_settings?: {
    gecko?: { id?: string };
  };
};

async function readManifest(kind: string): Promise<BuiltManifest> {
  return JSON.parse(
    await fs.readFile(
      path.join(packageRoot, "dist", kind, "manifest.json"),
      "utf8",
    ),
  ) as BuiltManifest;
}

async function buildExtension(kind: string): Promise<void> {
  await run("bun", [path.join(packageRoot, "scripts", "build.mjs"), kind], {
    cwd: packageRoot,
    stdio: "pipe",
  });
}

describe("cross-browser extension build", () => {
  it("uses a validated reproducible timestamp for release metadata", () => {
    expect(resolveSourceDateIso({ SOURCE_DATE_EPOCH: "0" })).toBe(
      "1970-01-01T00:00:00.000Z",
    );
    expect(resolveSourceDateIso({ SOURCE_DATE_EPOCH: "172800" })).toBe(
      "1970-01-03T00:00:00.000Z",
    );
    expect(() =>
      resolveSourceDateIso({ SOURCE_DATE_EPOCH: "not-a-number" }),
    ).toThrow(/Invalid SOURCE_DATE_EPOCH/);
  });

  it("rejects unknown build targets instead of silently producing Chrome", () => {
    expect(() => parseBrowserBridgeBuildKind("netscape")).toThrow(
      /Expected chrome, firefox, or safari/,
    );
  });

  it("emits least-privilege Chrome and Firefox manifests from shared code", async () => {
    await buildExtension("chrome");
    await buildExtension("firefox");
    const chrome = await readManifest("chrome");
    const firefox = await readManifest("firefox");

    for (const manifest of [chrome, firefox]) {
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.host_permissions).not.toContain("<all_urls>");
      expect(manifest.optional_host_permissions).toEqual([
        "https://*/*",
        "http://*/*",
      ]);
      expect(manifest.content_security_policy.extension_pages).toBe(
        "script-src 'self'; object-src 'self'",
      );
      expect(manifest.content_security_policy.extension_pages).not.toContain(
        "unsafe-eval",
      );
    }

    expect(chrome.background).toEqual({ service_worker: "background.js" });
    expect(chrome.browser_specific_settings).toBeUndefined();
    expect(firefox.background).toEqual({ scripts: ["background.js"] });
    expect(firefox.browser_specific_settings?.gecko?.id).toBe(
      "browser-bridge@elizaos.ai",
    );
  });

  it("creates byte-identical root-layout archives on repeated packaging", async () => {
    await buildExtension("firefox");
    const sourceDir = path.join(packageRoot, "dist", "firefox");
    const firstPath = path.join(packageRoot, "dist", "test-firefox-1.xpi");
    const secondPath = path.join(packageRoot, "dist", "test-firefox-2.xpi");
    await createDeterministicWebExtensionArchive({
      sourceDir,
      outputPath: firstPath,
    });
    await createDeterministicWebExtensionArchive({
      sourceDir,
      outputPath: secondPath,
    });
    const [first, second] = await Promise.all([
      fs.readFile(firstPath),
      fs.readFile(secondPath),
    ]);
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      createHash("sha256").update(second).digest("hex"),
    );
  });
});
