/** Runs candidate evaluation with explicit child state and no inherited provider credentials. */

import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { gepaHash, parseGepaPlannerCase } from "./gepa-planner-case.ts";

export async function runIsolatedGepaPlannerCase(
  value: unknown,
  timeoutMs = 30_000,
  options: {
    signal?: AbortSignal;
    onWorkerStarted?: (worker: { pid: number; stateRoot: string }) => void;
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("A positive evaluation timeout is required");
  options.signal?.throwIfAborted();
  const input = parseGepaPlannerCase(value);
  const expectedHash = gepaHash(input);
  const stateRoot = await realpath(
    await mkdtemp(join(tmpdir(), "eliza-gepa-case-")),
  );
  try {
    const child = spawn(
      "bun",
      [
        "--conditions=eliza-source",
        "--tsconfig-override",
        fileURLToPath(new URL("../../../../tsconfig.json", import.meta.url)),
        fileURLToPath(
          new URL("./gepa-planner-case-worker.ts", import.meta.url),
        ),
      ],
      {
        cwd: stateRoot,
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          HOME: stateRoot,
          USERPROFILE: stateRoot,
          TMPDIR: stateRoot,
          ELIZA_STATE_DIR: stateRoot,
          PGLITE_DATA_DIR: join(stateRoot, "pglite"),
          ELIZA_DISABLE_ACTIVITY_TRACKER: "true",
          ELIZA_DISABLE_PROACTIVE_AGENT: "true",
          ELIZA_DISABLE_LIFEOPS_SCHEDULER: "true",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let spawnFailure: Error | undefined;
    let closed = false;
    const exited = new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        spawnFailure = error;
      });
      child.once("close", (code) => {
        closed = true;
        resolve(code);
      });
    });
    const abort = () => {
      if (!closed) child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    let inputFailure: Error | undefined;
    child.stdin.on("error", (error) => {
      inputFailure = error;
    });
    child.stdin.end(JSON.stringify(input));
    const collect = async (stream: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    try {
      if (options.signal?.aborted) abort();
      if (child.pid) options.onWorkerStarted?.({ pid: child.pid, stateRoot });
      const [code, stdout, stderr] = await Promise.all([
        exited,
        collect(child.stdout),
        collect(child.stderr),
      ]);
      options.signal?.throwIfAborted();
      if (spawnFailure) throw spawnFailure;
      if (timedOut || code !== 0 || inputFailure)
        throw new Error(
          `GEPA case inconclusive (${timedOut ? "timeout" : `exit ${code}`}):\n${stderr}\n${stdout}`,
        );
      const evidence = JSON.parse(
        await readFile(join(stateRoot, "evidence.json"), "utf8"),
      );
      if (
        evidence.caseSha256 !== expectedHash ||
        gepaHash(evidence.input) !== expectedHash ||
        evidence.activated !== false ||
        evidence.qualification !== "deterministic-planner-boundary-only"
      )
        throw new Error(
          "Child evidence does not match the immutable evaluation input",
        );
      return evidence;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // A stream/observer failure also reaches here: terminate and reap before state removal.
      abort();
      await exited;
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv.length !== 3)
    throw new Error(
      "Usage: bun --conditions=eliza-source gepa-planner-case-process.ts CASE.json",
    );
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("GEPA CLI interrupted"));
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const evidence = await runIsolatedGepaPlannerCase(
      JSON.parse(await readFile(process.argv[2], "utf8")),
      30_000,
      {
        signal: controller.signal,
        onWorkerStarted: (worker) =>
          process.stderr.write(`${JSON.stringify({ worker })}\n`),
      },
    );
    const directory = testOutputPath("gepa-case-worker");
    await mkdir(directory, { recursive: true });
    const destination = join(directory, `${evidence.caseSha256}.json`);
    await writeFile(destination, JSON.stringify(evidence, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    process.stdout.write(`${destination}\n`);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
