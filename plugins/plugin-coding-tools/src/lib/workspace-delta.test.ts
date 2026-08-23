/** Tests local Git worktree delta capture against real temporary repositories. */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginLocalWorkspaceDeltaObservation,
  finishLocalWorkspaceDeltaObservation,
} from "./workspace-delta";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

async function repository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-delta-"));
  cleanup.push(root);
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
  await fs.writeFile(path.join(root, "tracked.txt"), "initial\n", "utf8");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((root) => fs.rm(root, { recursive: true })),
  );
});

describe("local workspace delta observation", () => {
  it("detects a content change when the porcelain status code was already dirty", async () => {
    const root = await repository();
    await fs.writeFile(
      path.join(root, "tracked.txt"),
      "dirty-before\n",
      "utf8",
    );
    const before = await beginLocalWorkspaceDeltaObservation(root);
    await fs.writeFile(path.join(root, "tracked.txt"), "dirty-after\n", "utf8");

    const receipt = await finishLocalWorkspaceDeltaObservation(before);

    expect(receipt).toMatchObject({
      outcome: "changed",
      scope: {
        root: await fs.realpath(root),
        coverage: "tracked_and_untracked_nonignored",
      },
    });
    expect(receipt?.beforeFingerprint).not.toBe(receipt?.afterFingerprint);
    expect(JSON.stringify(receipt)).not.toContain("dirty-after");
  });

  it("detects creation and later modification of a non-ignored untracked file", async () => {
    const root = await repository();
    const beforeCreate = await beginLocalWorkspaceDeltaObservation(root);
    await fs.writeFile(path.join(root, "generated.ts"), "one\n", "utf8");
    expect(
      (await finishLocalWorkspaceDeltaObservation(beforeCreate))?.outcome,
    ).toBe("changed");

    const beforeModify = await beginLocalWorkspaceDeltaObservation(root);
    await fs.writeFile(path.join(root, "generated.ts"), "two\n", "utf8");
    expect(
      (await finishLocalWorkspaceDeltaObservation(beforeModify))?.outcome,
    ).toBe("changed");
  });

  it("detects a modify-and-commit command whose final worktree is clean", async () => {
    const root = await repository();
    const before = await beginLocalWorkspaceDeltaObservation(root);
    await fs.writeFile(path.join(root, "tracked.txt"), "committed\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "modify tracked file"], {
      cwd: root,
    });

    const receipt = await finishLocalWorkspaceDeltaObservation(before);

    expect(receipt?.outcome).toBe("changed");
    expect(receipt?.beforeFingerprint).not.toBe(receipt?.afterFingerprint);
    expect(
      (await execFileAsync("git", ["status", "--porcelain"], { cwd: root }))
        .stdout,
    ).toBe("");
  });

  it("detects switching between clean branches with different HEADs", async () => {
    const root = await repository();
    await execFileAsync("git", ["branch", "alternate"], { cwd: root });
    const before = await beginLocalWorkspaceDeltaObservation(root);
    await execFileAsync("git", ["switch", "-q", "alternate"], { cwd: root });

    const receipt = await finishLocalWorkspaceDeltaObservation(before);

    expect(receipt?.outcome).toBe("changed");
    expect(receipt?.beforeFingerprint).not.toBe(receipt?.afterFingerprint);
    expect(
      (await execFileAsync("git", ["status", "--porcelain"], { cwd: root }))
        .stdout,
    ).toBe("");
  });

  it("reports indeterminate when a known worktree's Git probe fails", async () => {
    const root = await repository();
    const observation = await beginLocalWorkspaceDeltaObservation(root, {
      runGit: async () => {
        throw new Error("injected Git failure");
      },
    });

    expect(
      await finishLocalWorkspaceDeltaObservation(observation),
    ).toMatchObject({
      outcome: "indeterminate",
      reasonCode: "WORKTREE_PROBE_FAILED",
      scope: { root: await fs.realpath(root) },
    });
  });

  it("reports unchanged for a read-only interval and no receipt outside Git", async () => {
    const root = await repository();
    const before = await beginLocalWorkspaceDeltaObservation(root);
    expect((await finishLocalWorkspaceDeltaObservation(before))?.outcome).toBe(
      "unchanged",
    );

    const nonRepo = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-no-git-"),
    );
    cleanup.push(nonRepo);
    expect(await beginLocalWorkspaceDeltaObservation(nonRepo)).toBeUndefined();
    expect(
      await beginLocalWorkspaceDeltaObservation(nonRepo, {
        runGit: async () => {
          throw new Error("injected Git failure");
        },
      }),
    ).toBeUndefined();
  });
});
