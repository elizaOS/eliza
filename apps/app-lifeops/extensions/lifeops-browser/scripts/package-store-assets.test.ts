import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const artifactsDir = path.join(extensionRoot, "dist", "artifacts");

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: extensionRoot,
      env,
      stdio: "pipe",
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

describe("LifeOps Browser store metadata packaging", () => {
  it("writes Chrome and Safari store artifacts with configured release URLs", async () => {
    await run("bun", ["scripts/package-store-assets.mjs"], {
      ...process.env,
      ELIZA_LIFEOPS_BROWSER_MARKETING_URL: "https://lifeops.example.com",
      ELIZA_LIFEOPS_BROWSER_SUPPORT_URL:
        "https://lifeops.example.com/support",
      ELIZA_LIFEOPS_BROWSER_PRIVACY_POLICY_URL:
        "https://lifeops.example.com/privacy",
      ELIZA_LIFEOPS_BROWSER_CHROME_STORE_URL:
        "https://chromewebstore.google.com/detail/lifeops-browser/mockid",
      ELIZA_LIFEOPS_BROWSER_SAFARI_STORE_URL:
        "https://apps.apple.com/us/app/lifeops-browser/id1234567890",
    });

    const chromeMetadata = JSON.parse(
      await fs.readFile(
        path.join(artifactsDir, "lifeops-browser-chrome-store-metadata.json"),
        "utf8",
      ),
    ) as {
      title: string;
      supportUrl: string | null;
      privacyPolicyUrl: string | null;
      storeListingUrl: string | null;
      permissions: Array<{ name: string; justification: string }>;
    };
    const safariMetadata = JSON.parse(
      await fs.readFile(
        path.join(artifactsDir, "lifeops-browser-safari-store-metadata.json"),
        "utf8",
      ),
    ) as {
      appName: string;
      bundleIdentifier: string;
      supportUrl: string | null;
      privacyPolicyUrl: string | null;
      storeListingUrl: string | null;
    };
    const checklist = await fs.readFile(
      path.join(artifactsDir, "lifeops-browser-store-checklist.md"),
      "utf8",
    );

    expect(chromeMetadata.title).toBe("LifeOps Browser");
    expect(chromeMetadata.supportUrl).toBe(
      "https://lifeops.example.com/support",
    );
    expect(chromeMetadata.privacyPolicyUrl).toBe(
      "https://lifeops.example.com/privacy",
    );
    expect(chromeMetadata.storeListingUrl).toContain("chromewebstore");
    expect(chromeMetadata.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "tabs",
        }),
        expect.objectContaining({
          name: "<all_urls>",
        }),
      ]),
    );
    expect(
      chromeMetadata.permissions.every(
        (permission) => permission.justification.trim().length > 0,
      ),
    ).toBe(true);

    expect(safariMetadata.appName).toBe("LifeOps Browser");
    expect(safariMetadata.bundleIdentifier).toBe("ai.lifeops.browser");
    expect(safariMetadata.supportUrl).toBe(
      "https://lifeops.example.com/support",
    );
    expect(safariMetadata.privacyPolicyUrl).toBe(
      "https://lifeops.example.com/privacy",
    );
    expect(safariMetadata.storeListingUrl).toContain("apps.apple.com");

    expect(checklist).toContain("## Chrome Web Store");
    expect(checklist).toContain("## Safari App Store");
    expect(checklist).not.toContain("REQUIRED:");
  });
});
