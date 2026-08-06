import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./checkpoint", () => ({
  ensureVerifyCheckpoint: vi.fn(async () => ({
    created: true,
    checkpointName: "verify-nextjs-test",
    guestWorkdir: "/grok/verify/worktree",
  })),
}));

import { prepareVerifySandbox } from "./entrypoint";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("prepareVerifySandbox", () => {
  it("adds checkpoint-backed sandbox settings for verify execution", async () => {
    const dir = makeTempDir("grok-verify-runtime-prep-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev", build: "next build" } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, "package-lock.json"), "");

    const prepared = await prepareVerifySandbox(dir, { allowNet: false });
    expect(prepared.profile.appKind).toBe("nextjs");
    expect(prepared.sandboxSettings.allowNet).toBe(true);
    expect(prepared.sandboxSettings.from).toBe("verify-nextjs-test");
    expect(prepared.sandboxSettings.guestWorkdir).toBe("/grok/verify/worktree");
    expect(prepared.sandboxSettings.syncHostWorkspace).toBe(true);
    expect(prepared.checkpoint?.created).toBe(true);
  });
});
