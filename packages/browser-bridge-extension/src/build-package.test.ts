/**
 * Exercises real cross-browser build output and reproducible archive generation.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseBrowserBridgeBuildKind } from "../scripts/build.mjs";
import {
  createDeterministicDirectoryArchive,
  createDeterministicWebExtensionArchive,
} from "../scripts/package-webextension.mjs";
import { resolveSourceDateIso } from "../scripts/release-version.mjs";
import { run } from "../scripts/script-utils.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

type BuiltManifest = {
  manifest_version: number;
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions: string[];
  content_scripts: Array<{ js: string[]; all_frames?: boolean }>;
  web_accessible_resources: Array<{
    resources: string[];
    matches: string[];
    use_dynamic_url?: boolean;
  }>;
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

    for (const [kind, manifest] of [
      ["chrome", chrome],
      ["firefox", firefox],
    ] as const) {
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.host_permissions).not.toContain("<all_urls>");
      expect(manifest.host_permissions).toEqual([
        "http://127.0.0.1/*",
        "http://localhost/*",
      ]);
      expect(manifest.optional_host_permissions).toEqual([
        "https://*/*",
        "http://*/*",
      ]);
      expect(manifest.permissions).toContain(
        "declarativeNetRequestWithHostAccess",
      );
      expect(manifest.permissions).not.toContain("declarativeNetRequest");
      expect(manifest.content_security_policy.extension_pages).toBe(
        "script-src 'self'; object-src 'self'",
      );
      expect(manifest.content_security_policy.extension_pages).not.toContain(
        "unsafe-eval",
      );
      expect(manifest.content_scripts).toEqual([
        expect.objectContaining({ js: ["content.js"] }),
      ]);
      expect(
        manifest.content_scripts.flatMap((entry) => entry.js),
      ).not.toContain("wallet-shim.js");
      expect(manifest.web_accessible_resources).toEqual([
        {
          resources: ["blocked.html", "blocked.js"],
          matches: ["http://*/*", "https://*/*"],
          ...(kind === "chrome" ? { use_dynamic_url: true } : {}),
        },
      ]);
    }

    expect(chrome.background).toEqual({ service_worker: "background.js" });
    expect(chrome.browser_specific_settings).toBeUndefined();
    expect(firefox.background).toEqual({ scripts: ["background.js"] });
    expect(firefox.browser_specific_settings?.gecko?.id).toBe(
      "browser-bridge@elizaos.ai",
    );
  }, 30_000);

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
    expect(
      Object.keys(unzipSync(new Uint8Array(first))).some((name) =>
        name.endsWith(".map"),
      ),
    ).toBe(false);
  }, 30_000);

  it("preserves executable modes in deterministic directory archives", async () => {
    const sourceDir = path.join(packageRoot, "dist", "test-app");
    const executablePath = path.join(sourceDir, "Contents", "MacOS", "bridge");
    await fs.mkdir(path.dirname(executablePath), { recursive: true });
    await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const first = await createDeterministicDirectoryArchive({
      sourceDir,
      outputPath: path.join(packageRoot, "dist", "test-app-1.zip"),
      rootName: "Test.app",
    });
    const second = await createDeterministicDirectoryArchive({
      sourceDir,
      outputPath: path.join(packageRoot, "dist", "test-app-2.zip"),
      rootName: "Test.app",
    });
    expect(first.sha256).toBe(second.sha256);
  });
});
