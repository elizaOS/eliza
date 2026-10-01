import { expect, test } from "bun:test";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runStabilityCleanup,
  writeParentOwnedStabilityLog,
} from "./attempt-cleanup.ts";

test("a rejected evidence write cannot leave the owned listener running", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stability-cleanup-"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  let failure: unknown;
  try {
    try {
      await runStabilityCleanup([
        () => writeParentOwnedStabilityLog(directory, "evidence"),
        () => writeFile(path.join(directory, "cleanup.receipt"), "closed"),
        close,
      ]);
    } catch (error) {
      failure = error;
    }
    expect(server.listening).toBe(false);
    expect(
      await readFile(path.join(directory, "cleanup.receipt"), "utf8"),
    ).toBe("closed");
    expect(failure).toMatchObject({ code: "EISDIR" });
  } finally {
    if (server.listening) await close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("evidence overwrite preserves private files and rejects linked destinations", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stability-log-"));
  try {
    const target = path.join(directory, "target");
    writeParentOwnedStabilityLog(target, "old evidence");
    writeParentOwnedStabilityLog(target, "new");
    expect(await readFile(target, "utf8")).toBe("new");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    const symbolic = path.join(directory, "symbolic");
    await symlink(target, symbolic);
    expect(() => writeParentOwnedStabilityLog(symbolic, "overwrite")).toThrow();
    const hard = path.join(directory, "hard");
    await link(target, hard);
    expect(() => writeParentOwnedStabilityLog(hard, "overwrite")).toThrow();
    expect(await readFile(target, "utf8")).toBe("new");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("execution and cleanup errors remain visible after later cleanup completes", async () => {
  const executionFailure = new Error("attempt failed");
  const cleanupFailure = new Error("first cleanup failed");
  let finalCleanupCompleted = false;
  let failure: unknown;
  try {
    await runStabilityCleanup(
      [
        () => {
          throw cleanupFailure;
        },
        () => {
          finalCleanupCompleted = true;
        },
      ],
      [executionFailure],
    );
  } catch (error) {
    failure = error;
  }
  expect(finalCleanupCompleted).toBe(true);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    executionFailure,
    cleanupFailure,
  ]);
});
