import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const appPackage = JSON.parse(
  readFileSync(path.resolve(testDir, "../package.json"), "utf8"),
) as { scripts: Record<string, string> };

const script = (name: string) => appPackage.scripts[name] ?? "";

describe("mobile simulator smoke package scripts", () => {
  it("makes public local-chat simulator lanes require a real installed app", () => {
    for (const name of [
      "test:sim:local-chat",
      "test:sim:local-chat:ios",
      "test:sim:local-chat:android",
      "test:sim:local-chat:both",
    ]) {
      expect(script(name), name).toContain("mobile-local-chat-smoke.mjs");
      expect(script(name), name).toContain("--require-installed");
    }
  });

  it("exposes the loud one-command iOS e2e orchestrator", () => {
    expect(script("test:e2e:ios")).toBe("node scripts/ios-e2e.mjs");
    expect(script("test:e2e:ios:cloud")).toBe(
      "node scripts/ios-e2e.mjs --cloud",
    );
  });
});
