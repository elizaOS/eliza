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

describe("mobile-build-smoke.yml iOS chat-correctness gating (#13576)", () => {
  const workflow = readFileSync(
    path.resolve(testDir, "../../../.github/workflows/mobile-build-smoke.yml"),
    "utf8",
  );
  const STEP_MARKER = "      - name:";

  // Return the YAML text of the single workflow step whose `- name:` line
  // contains the given fragment, up to (but excluding) the next step.
  const stepBlock = (nameFragment: string): string => {
    const at = workflow.indexOf(nameFragment);
    expect(at, `step named like "${nameFragment}" must exist`).toBeGreaterThan(
      -1,
    );
    const start = workflow.lastIndexOf(STEP_MARKER, at);
    expect(start, `step marker for "${nameFragment}"`).toBeGreaterThan(-1);
    const next = workflow.indexOf(`\n${STEP_MARKER}`, start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
  };

  // These lanes were promoted from continue-on-error (self-skip to success)
  // to hard-gating in #13576. Reintroducing continue-on-error here would let a
  // regression in iOS chat send/receive or the media-store/Filesystem/Share
  // path ship a green Mobile Build Smoke check — this test blocks that.
  for (const lane of [
    "Run iOS native attachment smoke",
    "Run iOS local-chat simulator smoke",
  ]) {
    it(`keeps the "${lane}" lane blocking (no continue-on-error)`, () => {
      expect(stepBlock(lane)).not.toContain("continue-on-error");
    });
  }

  it("still drives the promoted lanes through their real smoke scripts", () => {
    expect(stepBlock("Run iOS native attachment smoke")).toContain(
      "ios-attachment-smoke.mjs",
    );
    const localChat = stepBlock("Run iOS local-chat simulator smoke");
    expect(localChat).toContain("mobile-local-chat-smoke.mjs");
    expect(localChat).toContain("--platform ios --require-installed");
  });
});
