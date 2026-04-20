import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: extensionRoot,
      stdio: "pipe",
      env: process.env,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with ${code ?? "unknown"}\n${stderr}`,
        ),
      );
    });
  });
}

async function readBuiltManifest(kind: "chrome" | "safari") {
  await run("bun", ["scripts/build.mjs", kind]);
  const manifestPath = path.join(extensionRoot, "dist", kind, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    manifest_version: number;
    name: string;
    description: string;
    permissions: string[];
    host_permissions: string[];
    action?: { default_popup?: string };
    background?: { service_worker?: string };
    content_scripts?: Array<{ matches?: string[]; js?: string[] }>;
    browser_specific_settings?: {
      safari?: {
        strict_min_version?: string;
      };
    };
  };
  return { manifest, outputDir: path.dirname(manifestPath) };
}

describe("LifeOps Browser extension build", () => {
  it("builds a Chrome manifest with the required relay permissions", async () => {
    const { manifest, outputDir } = await readBuiltManifest("chrome");

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe("LifeOps Browser");
    expect(manifest.description).toContain("LifeOps personal-browser relay");
    expect(manifest.permissions).toEqual(
      expect.arrayContaining([
        "tabs",
        "storage",
        "scripting",
        "alarms",
        "activeTab",
        "declarativeNetRequest",
        "declarativeNetRequestWithHostAccess",
      ]),
    );
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
    expect(manifest.action?.default_popup).toBe("popup.html");
    expect(manifest.background?.service_worker).toBe("background.js");
    expect(manifest.content_scripts?.[0]?.matches).toEqual(["<all_urls>"]);
    expect(manifest.browser_specific_settings).toBeUndefined();

    await fs.access(path.join(outputDir, "popup.html"));
    await fs.access(path.join(outputDir, "blocked.html"));
    await fs.access(path.join(outputDir, "background.js"));
    await fs.access(path.join(outputDir, "content.js"));
  });

  it("builds a Safari manifest with Safari-specific browser settings", async () => {
    const { manifest, outputDir } = await readBuiltManifest("safari");

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe("LifeOps Browser");
    expect(manifest.browser_specific_settings?.safari?.strict_min_version).toBe(
      "17.0",
    );
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);

    await fs.access(path.join(outputDir, "popup.html"));
    await fs.access(path.join(outputDir, "blocked.html"));
  });
});
