/** Implements Electrobun git remote phase7 smoke ts boundaries for desktop app-core. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitException } from "../bun/errors.ts";
import { GitCommandRunner } from "../bun/git-command.ts";
import { GitRemoteService } from "../bun/git-service.ts";

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "eliza-git-"));
const runner = new GitCommandRunner();
const service = new GitRemoteService({ runner });

try {
  await runner.run({ name: "smoke.git.init", cwd: tempRoot, args: ["init"] });
  await runner.run({
    name: "smoke.git.config.email",
    cwd: tempRoot,
    args: ["config", "user.email", "eliza-smoke@example.local"],
  });
  await runner.run({
    name: "smoke.git.config.name",
    cwd: tempRoot,
    args: ["config", "user.name", "Eliza Smoke"],
  });
  writeFileSync(
    path.join(tempRoot, "hello.txt"),
    "hello from git remote\n",
    "utf8",
  );

  const info = await service.repoInfo({ cwd: tempRoot });
  assert(info.isRepo === true, "repoInfo works");

  const statusBeforeAdd = await service.statusRepo({ cwd: tempRoot });
  assert(
    statusBeforeAdd.files.some((file) => file.path === "hello.txt"),
    "status detects untracked file",
  );

  const add = await service.add({ cwd: tempRoot, paths: ["hello.txt"] });
  assert(add.operation.status === "completed", "add works");

  const commit = await service.commit({
    cwd: tempRoot,
    message: "initial smoke commit",
  });
  assert(commit.operation.status === "completed", "commit works");

  const log = await service.log({ cwd: tempRoot, limit: 5 });
  assert(log[0]?.subject === "initial smoke commit", "log includes commit");

  writeFileSync(
    path.join(tempRoot, "hello.txt"),
    "updated git remote\n",
    "utf8",
  );
  const diff = await service.diff({ cwd: tempRoot, path: "hello.txt" });
  assert(diff.raw.includes("updated git remote"), "diff works");

  const show = await service.show({
    cwd: tempRoot,
    ref: "HEAD",
    path: "hello.txt",
  });
  assert(show.raw.includes("hello from git remote"), "show works");

  const branches = await service.branches({ cwd: tempRoot });
  assert(branches.length >= 1, "branches work");

  const remotes = await service.remotes({ cwd: tempRoot });
  assert(Array.isArray(remotes), "remotes works");

  await service.branchCreate({ cwd: tempRoot, name: "phase7-smoke" });
  await service.checkout({ cwd: tempRoot, ref: "phase7-smoke" });
  await service.checkout({ cwd: tempRoot, ref: defaultBranch(branches) });
  const branchDelete = await service.branchDelete({
    cwd: tempRoot,
    name: "phase7-smoke",
    force: true,
  });
  assert(branchDelete.operation.status === "completed", "branch delete works");

  await service.restore({ cwd: tempRoot, paths: ["hello.txt"] });
  const cleanStatus = await service.statusRepo({ cwd: tempRoot });
  assert(cleanStatus.files.length === 0, "restore works");

  await expectGitError(
    () => service.push({ cwd: tempRoot, remote: "origin" }),
    "GIT_COMMAND_FAILED",
    "push without remote returns structured error",
  );

  const operationList = await service.operationList({ limit: 20 });
  assert(operationList.length > 0, "operation list works");
  const operationGet = await service.operationGet({
    operationId: operationList[0].id,
  });
  assert(operationGet.id === operationList[0].id, "operation get works");

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        root: info.root,
        branchCount: branches.length,
        remoteCount: remotes.length,
        logSubject: log[0]?.subject,
        operationCount: operationList.length,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function defaultBranch(
  branches: Array<{ name: string; current: boolean }>,
): string {
  const current = branches.find((branch) => branch.current);
  if (current) return current.name;
  return branches[0]?.name ?? "main";
}

async function expectGitError(
  action: () => Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof GitException && error.code === code) return;
    throw error;
  }
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
