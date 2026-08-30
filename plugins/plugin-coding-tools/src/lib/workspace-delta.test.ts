/** Tests local Git worktree delta capture against real temporary repositories. */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  __runWorkspaceDeltaGitForTests,
  beginLocalWorkspaceDeltaObservation as beginObservation,
  finishLocalWorkspaceDeltaObservation,
  type LocalWorkspaceDeltaDependencies,
  runtimeWorkspaceExecutionDomainId,
} from "./workspace-delta";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
const TEST_EXECUTION_DOMAIN_ID = "d".repeat(64);

function beginLocalWorkspaceDeltaObservation(
  cwd: string,
  dependencies: LocalWorkspaceDeltaDependencies = {},
) {
  return beginObservation(cwd, {
    executionDomainId: TEST_EXECUTION_DOMAIN_ID,
    maxObservationMs: 10_000,
    ...dependencies,
  });
}

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
    cleanup
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("local workspace delta observation", () => {
  it("derives distinct opaque domains for distinct runtime instances without environment ids", () => {
    const runtime = () =>
      new AgentRuntime({ character: { name: "shared-character" } as never });
    expect(runtimeWorkspaceExecutionDomainId(runtime())).not.toBe(
      runtimeWorkspaceExecutionDomainId(runtime()),
    );
  });

  it("detects a content change when the tracked path was already dirty", async () => {
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

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "detects content changes hidden by %s",
    async (flag) => {
      const root = await repository();
      await execFileAsync("git", ["update-index", flag, "tracked.txt"], {
        cwd: root,
      });
      const before = await beginLocalWorkspaceDeltaObservation(root);
      await fs.writeFile(path.join(root, "tracked.txt"), `${flag}\n`, "utf8");

      expect(
        (await finishLocalWorkspaceDeltaObservation(before))?.outcome,
      ).toBe("changed");
    },
  );

  it("detects further changes inside an already-dirty submodule", async () => {
    const child = await repository();
    const root = await repository();
    await execFileAsync(
      "git",
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        child,
        "nested",
      ],
      { cwd: root },
    );
    await execFileAsync("git", ["commit", "-qam", "add nested"], { cwd: root });
    const nestedFile = path.join(root, "nested", "tracked.txt");
    await fs.writeFile(nestedFile, "dirty-before\n", "utf8");
    const before = await beginLocalWorkspaceDeltaObservation(root);
    await fs.writeFile(nestedFile, "dirty-after\n", "utf8");

    expect((await finishLocalWorkspaceDeltaObservation(before))?.outcome).toBe(
      "changed",
    );
  });

  it("supports an unborn repository before its first commit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-unborn-"));
    cleanup.push(root);
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    const before = await beginLocalWorkspaceDeltaObservation(root);
    await fs.writeFile(path.join(root, "first.txt"), "first\n", "utf8");

    expect((await finishLocalWorkspaceDeltaObservation(before))?.outcome).toBe(
      "changed",
    );
  });

  it("accepts only Git's expected detached-HEAD status as detached", async () => {
    const root = await repository();
    await execFileAsync("git", ["checkout", "--detach", "-q"], { cwd: root });
    const before = await beginLocalWorkspaceDeltaObservation(root);
    expect((await finishLocalWorkspaceDeltaObservation(before))?.outcome).toBe(
      "unchanged",
    );
  });

  it.each([
    ["rev-parse HEAD", ["rev-parse", "--verify", "HEAD"]],
    ["symbolic-ref HEAD", ["symbolic-ref", "--quiet", "HEAD"]],
  ])(
    "treats an unexpected %s failure as indeterminate",
    async (_name, injectedArgs) => {
      const root = await repository();
      const observation = await beginLocalWorkspaceDeltaObservation(root, {
        runGit: async (cwd, args, limits) => {
          if (args.join("\0") === injectedArgs.join("\0")) {
            throw new Error("injected unexpected Git failure");
          }
          const result = await execFileAsync("git", args, {
            cwd,
            encoding: "utf8",
            timeout: limits?.timeoutMs,
            maxBuffer: limits?.maxOutputBytes,
          });
          return result.stdout;
        },
      });

      expect(
        await finishLocalWorkspaceDeltaObservation(observation),
      ).toMatchObject({
        outcome: "indeterminate",
        reasonCode: "BASELINE_SNAPSHOT_FAILED",
      });
    },
  );

  it.each([
    [
      "missing HEAD with appended diagnostics",
      ["rev-parse", "--verify", "HEAD"],
      { code: 128, stderr: "fatal: Needed a single revision\nunexpected" },
    ],
    [
      "detached HEAD with unexpected stdout",
      ["symbolic-ref", "--quiet", "HEAD"],
      { code: 1, stderr: "", stdout: "unexpected" },
    ],
  ])(
    "rejects the near-miss Git state %s",
    async (_name, injectedArgs, failure) => {
      const root = await repository();
      const observation = await beginLocalWorkspaceDeltaObservation(root, {
        runGit: async (cwd, args, limits) => {
          if (args.join("\0") === injectedArgs.join("\0")) throw failure;
          const result = await execFileAsync("git", args, {
            cwd,
            encoding: "utf8",
            timeout: limits?.timeoutMs,
            maxBuffer: limits?.maxOutputBytes,
          });
          return result.stdout;
        },
      });

      expect(
        await finishLocalWorkspaceDeltaObservation(observation),
      ).toMatchObject({
        outcome: "indeterminate",
        reasonCode: "BASELINE_SNAPSHOT_FAILED",
      });
    },
  );

  it("enforces one deterministic aggregate Git-output budget across coordinated parallel probes", async () => {
    const root = await repository();
    const observedCaps: number[] = [];
    const rootOutput = `${root}\n`;
    const observation = await beginLocalWorkspaceDeltaObservation(root, {
      maxGitOutputBytes: Buffer.byteLength(rootOutput) + 3,
      runGit: async (_cwd, args, limits) => {
        observedCaps.push(limits?.maxOutputBytes ?? -1);
        if (args.includes("--show-toplevel")) return rootOutput;
        if (args.includes("--verify")) return "aa";
        if (args.includes("symbolic-ref")) return "bb";
        return "cc";
      },
    });

    expect(
      await finishLocalWorkspaceDeltaObservation(observation),
    ).toMatchObject({
      outcome: "indeterminate",
      reasonCode: "OBSERVATION_OUTPUT_BUDGET_EXCEEDED",
    });
    expect(observedCaps).toEqual([...observedCaps].sort((a, b) => b - a));
  });

  it("charges stdout and stderr together inside disjoint multi-probe reservations", async () => {
    const root = await repository();
    const rootOutput = `${root}\n`;
    const observation = await beginLocalWorkspaceDeltaObservation(root, {
      maxGitOutputBytes: Buffer.byteLength(rootOutput) + 8_200,
      runGit: async (_cwd, args) => {
        if (args.includes("--show-toplevel")) {
          return { stdout: rootOutput, stderr: "" };
        }
        if (args.includes("--verify")) {
          return { stdout: "a".repeat(40), stderr: "warning" };
        }
        if (args.includes("symbolic-ref")) {
          return { stdout: "refs/heads/main\n", stderr: "" };
        }
        if (args.includes("--others")) {
          return { stdout: "", stderr: "stderr exceeds reservation" };
        }
        return { stdout: "", stderr: "" };
      },
    });

    expect(
      await finishLocalWorkspaceDeltaObservation(observation),
    ).toMatchObject({
      outcome: "indeterminate",
      reasonCode: "OBSERVATION_OUTPUT_BUDGET_EXCEEDED",
    });
  });

  it("enforces the aggregate reservation while a real child fills both streams", async () => {
    const root = await repository();
    const bothStreamsAlias =
      'alias.both=!node -e \'process.stdout.write("o".repeat(520)); process.stderr.write("e".repeat(520))\'';
    await expect(
      __runWorkspaceDeltaGitForTests(root, ["-c", bothStreamsAlias, "both"], {
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
      }),
    ).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });

  it("bounds stalled filesystem metadata and file-stream reads", async () => {
    const root = await repository();
    const metadata = await beginLocalWorkspaceDeltaObservation(root, {
      maxObservationMs: 20,
      fs: { realpath: async () => await new Promise<string>(() => {}) },
    });
    expect(await finishLocalWorkspaceDeltaObservation(metadata)).toMatchObject({
      outcome: "indeterminate",
      reasonCode: "OBSERVATION_TIME_BUDGET_EXCEEDED",
    });

    await fs.writeFile(path.join(root, "tracked.txt"), "dirty\n", "utf8");
    const lstat = await beginLocalWorkspaceDeltaObservation(root, {
      maxObservationMs: 20,
      fs: { lstat: async () => await new Promise(() => {}) },
    });
    expect(await finishLocalWorkspaceDeltaObservation(lstat)).toMatchObject({
      outcome: "indeterminate",
      reasonCode: "OBSERVATION_TIME_BUDGET_EXCEEDED",
    });

    const stream = await beginLocalWorkspaceDeltaObservation(root, {
      maxObservationMs: 20,
      fs: {
        createReadStream: () =>
          ({
            destroy() {},
            [Symbol.asyncIterator]() {
              return {
                next: async () => await new Promise(() => {}),
              };
            },
          }) as never,
      },
    });
    expect(await finishLocalWorkspaceDeltaObservation(stream)).toMatchObject({
      outcome: "indeterminate",
      reasonCode: "OBSERVATION_TIME_BUDGET_EXCEEDED",
    });

    await fs.symlink("tracked.txt", path.join(root, "untracked-link"));
    const readlink = await beginLocalWorkspaceDeltaObservation(root, {
      maxObservationMs: 20,
      fs: { readlink: async () => await new Promise(() => {}) },
    });
    expect(await finishLocalWorkspaceDeltaObservation(readlink)).toMatchObject({
      outcome: "indeterminate",
      reasonCode: "OBSERVATION_TIME_BUDGET_EXCEEDED",
    });
  });

  it("recursively fingerprints an untracked embedded repository and fails closed at its byte bound", async () => {
    const root = await repository();
    const embedded = path.join(root, "embedded");
    await fs.mkdir(embedded);
    await execFileAsync("git", ["init", "-q"], { cwd: embedded });
    await fs.writeFile(path.join(embedded, "payload.txt"), "one\n", "utf8");
    const before = await beginLocalWorkspaceDeltaObservation(root, {
      maxObservationMs: 10_000,
    });
    await fs.writeFile(path.join(embedded, "payload.txt"), "two\n", "utf8");
    expect((await finishLocalWorkspaceDeltaObservation(before))?.outcome).toBe(
      "changed",
    );

    const bounded = await beginLocalWorkspaceDeltaObservation(root, {
      maxFileBytes: 1,
    });
    expect(await finishLocalWorkspaceDeltaObservation(bounded)).toMatchObject({
      outcome: "indeterminate",
      reasonCode: "OBSERVATION_BYTE_BUDGET_EXCEEDED",
    });
  });

  it("streams untracked directory entries and fails closed at the entry-memory bound", async () => {
    const root = await repository();
    const embedded = path.join(root, "many-entries");
    await fs.mkdir(embedded);
    await execFileAsync("git", ["init", "-q"], { cwd: embedded });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        fs.writeFile(path.join(embedded, `entry-${index}.txt`), "x", "utf8"),
      ),
    );
    const observation = await beginLocalWorkspaceDeltaObservation(root, {
      maxDirectoryEntries: 4,
    });
    expect(
      await finishLocalWorkspaceDeltaObservation(observation),
    ).toMatchObject({
      outcome: "indeterminate",
      reasonCode: "OBSERVATION_BYTE_BUDGET_EXCEEDED",
    });
  });

  it("fails closed at file-byte, Git-output, and wall-clock budgets", async () => {
    const root = await repository();
    const byteBefore = await beginLocalWorkspaceDeltaObservation(root, {
      maxFileBytes: 4,
    });
    await fs.writeFile(path.join(root, "large.txt"), "12345", "utf8");
    expect(
      await finishLocalWorkspaceDeltaObservation(byteBefore),
    ).toMatchObject({
      outcome: "indeterminate",
      reasonCode: "OBSERVATION_BYTE_BUDGET_EXCEEDED",
    });

    const outputBefore = await beginLocalWorkspaceDeltaObservation(root, {
      maxGitOutputBytes: 1,
    });
    expect(
      await finishLocalWorkspaceDeltaObservation(outputBefore),
    ).toMatchObject({
      outcome: "indeterminate",
      reasonCode: "OBSERVATION_OUTPUT_BUDGET_EXCEEDED",
    });

    let clock = 0;
    const timedBefore = await beginLocalWorkspaceDeltaObservation(root, {
      maxObservationMs: 1,
      now: () => clock++,
    });
    expect(
      await finishLocalWorkspaceDeltaObservation(timedBefore),
    ).toMatchObject({
      outcome: "indeterminate",
      reasonCode: "OBSERVATION_TIME_BUDGET_EXCEEDED",
    });
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
