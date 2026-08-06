import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./checkpoint", () => ({
  ensureVerifyCheckpoint: vi.fn(async () => ({ created: false })),
}));

import { ensureVerifyCheckpoint } from "./checkpoint";
import { prepareVerifyRun, runVerifyOrchestration } from "./orchestrator";

const ensureVerifyCheckpointMock = vi.mocked(ensureVerifyCheckpoint);
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  ensureVerifyCheckpointMock.mockReset();
  ensureVerifyCheckpointMock.mockResolvedValue({ created: false });
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("verify orchestrator", () => {
  it("uses the environment manifest as the highest-priority recipe source", async () => {
    const dir = makeTempDir("grok-verify-orch-manifest-");
    fs.writeFileSync(
      path.join(dir, "environment.json"),
      JSON.stringify(
        {
          ecosystem: "custom",
          appKind: "node",
          appLabel: "Manifest app",
          install: ["npm ci"],
          build: ["npm run build"],
          smokeKind: "none",
        },
        null,
        2,
      ),
    );

    const agent = {
      getCwd: () => dir,
      getSandboxSettings: () => ({}),
      setSandboxSettings: vi.fn(),
      detectVerifyRecipe: vi.fn(async () => null),
      runTaskRequest: vi.fn(async () => ({ success: true, output: "ok" })),
    };

    const prepared = await prepareVerifyRun(agent, {});
    expect(prepared.profile.recipe.ecosystem).toBe("custom");
    expect(prepared.profile.recipe.installCommands).toEqual(["npm ci"]);
    expect(prepared.usedVerifyDetect).toBe(false);
    expect(agent.detectVerifyRecipe).not.toHaveBeenCalled();
  });

  it("creates .grok/environment.json from verify-detect when no manifest exists", async () => {
    const dir = makeTempDir("grok-verify-orch-generate-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev", build: "next build" } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, "package-lock.json"), "");

    const agent = {
      getCwd: () => dir,
      getSandboxSettings: () => ({}),
      setSandboxSettings: vi.fn(),
      detectVerifyRecipe: vi.fn(async () => ({
        ecosystem: "custom",
        appKind: "node",
        appLabel: "Agent recipe",
        shellInitCommands: ["export FOO=bar"],
        bootstrapCommands: ["echo bootstrap"],
        installCommands: ["npm ci"],
        buildCommands: ["npm run build"],
        testCommands: [],
        startCommand: "npm run start",
        startPort: "3000",
        smokeKind: "http" as const,
        smokeTarget: "http://127.0.0.1:3000",
        evidence: ["agent-detect"],
        notes: ["generated"],
      })),
      runTaskRequest: vi.fn(async () => ({ success: true, output: "ok" })),
    };

    const prepared = await prepareVerifyRun(agent, {});
    expect(prepared.manifestPath).toBe(path.join(dir, ".grok", "environment.json"));
    expect(fs.existsSync(prepared.manifestPath!)).toBe(true);
    expect(prepared.usedVerifyDetect).toBe(true);
    expect(prepared.profile.recipe.installCommands).toEqual(["npm ci"]);
    expect(prepared.profile.recipe.evidence).toContain("agent-detect");
  });

  it("does not create a manifest when verify-detect returns no recipe", async () => {
    const dir = makeTempDir("grok-verify-orch-no-manifest-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev", build: "next build" } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, "package-lock.json"), "");

    const agent = {
      getCwd: () => dir,
      getSandboxSettings: () => ({}),
      setSandboxSettings: vi.fn(),
      detectVerifyRecipe: vi.fn(async () => null),
      runTaskRequest: vi.fn(async () => ({ success: true, output: "ok" })),
    };

    const prepared = await prepareVerifyRun(agent, {});
    expect(prepared.manifestPath).toBeUndefined();
    expect(fs.existsSync(path.join(dir, ".grok", "environment.json"))).toBe(false);
    expect(prepared.usedVerifyDetect).toBe(false);
  });

  it("restores sandbox settings after running verification and wires checkpoint settings", async () => {
    const dir = makeTempDir("grok-verify-orch-run-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev", build: "next build" } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, "package-lock.json"), "");

    ensureVerifyCheckpointMock.mockResolvedValue({
      created: true,
      checkpointName: "verify-next-demo",
      guestWorkdir: "/grok/verify/worktree",
    });

    const originalSettings = { allowNet: false, from: "base" };
    const agent = {
      getCwd: () => dir,
      getSandboxSettings: vi.fn(() => originalSettings),
      setSandboxSettings: vi.fn(),
      detectVerifyRecipe: vi.fn(async () => null),
      runTaskRequest: vi.fn(async () => ({ success: true, output: "verified" })),
    };

    const result = await runVerifyOrchestration(agent, {});
    expect(result.success).toBe(true);
    expect(agent.setSandboxSettings).toHaveBeenCalledTimes(2);
    expect(agent.setSandboxSettings.mock.calls[0]?.[0]).toMatchObject({
      from: "verify-next-demo",
      guestWorkdir: "/grok/verify/worktree",
      syncHostWorkspace: true,
      allowNet: true,
    });
    expect(agent.setSandboxSettings.mock.calls[1]?.[0]).toBe(originalSettings);
  });
});
