/**
 * Exercises the workspace ACP provisioning boundary with real OS advisory
 * locks and concurrent Bun processes. Deterministic build hooks cover artifact
 * validation and freshness; subprocess cases prove exclusion, owner-crash
 * recovery, partial-build ordering, and deadline enforcement without a model.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitCommandLine } from "../../src/services/acp-native-transport";
import {
  formatAcpCommand,
  type ProvisionHooks,
  provisionWorkspaceElizaCodeAcp,
} from "../../src/services/acp-provisioning";

const ACP_MARKER = "eliza-code-acp";
const roots: string[] = [];
const originalPath = process.env.PATH;
const originalChildPidPath = process.env.ACP_TEST_CHILD_PID_PATH;
const workerFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "acp-provision-worker.ts",
);

type Workspace = {
  root: string;
  packageDir: string;
  distDir: string;
  output: string;
  fakeBun: string;
};

function makeTemp(): string {
  const root = join(
    tmpdir(),
    `eliza-acp-provision-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function makeWorkspace(binName = "bun"): Workspace {
  const root = makeTemp();
  const packageDir = join(root, "packages", "examples", "code");
  const distDir = join(packageDir, "dist");
  const binDir = join(root, "bin");
  mkdirSync(join(packageDir, "src"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(packageDir, "src", "acp.ts"),
    `// ${ACP_MARKER}\nexport {};\n`,
  );
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@test/acp", type: "module" }),
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
  writeFileSync(join(root, "bun.lock"), "lockfile-v1\n");
  writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{}}\n');
  const fakeBun = join(binDir, binName);
  writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeBun, 0o755);
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
  return {
    root,
    packageDir,
    distDir,
    output: join(distDir, "acp.js"),
    fakeBun,
  };
}

function goodBuild(counter?: { count: number }) {
  return ({ tmpOutput }: { tmpOutput: string }) => {
    if (counter) counter.count += 1;
    writeFileSync(tmpOutput, `// ${ACP_MARKER}\ncomplete\n`);
    return { ok: true, detail: "" };
  };
}

function withDeterministicLease(hooks: ProvisionHooks): ProvisionHooks {
  return {
    tryAcquireBuildLease: () => ({ release: () => undefined }),
    ...hooks,
  };
}

function provisionWithTestLease(startDir: string, hooks: ProvisionHooks) {
  return provisionWorkspaceElizaCodeAcp(
    startDir,
    withDeterministicLease(hooks),
  );
}

function findRealBun(): string {
  for (const directory of (originalPath ?? "").split(delimiter)) {
    const candidate = join(directory, "bun");
    if (directory && existsSync(candidate)) return candidate;
  }
  throw new Error("A real Bun executable is required for concurrency tests");
}

function hasRealProvisioningPrimitives(): boolean {
  const executable = (name: string) => {
    for (const directory of (originalPath ?? "").split(delimiter)) {
      const candidate = join(directory, name);
      if (directory && existsSync(candidate)) return candidate;
    }
    return undefined;
  };
  const flock = executable("flock");
  const timeout = executable("timeout");
  if (!flock || !timeout) return false;
  const flockVersion = spawnSync(flock, ["--version"], {
    encoding: "utf8",
    timeout: 500,
    killSignal: "SIGKILL",
  });
  const timeoutVersion = spawnSync(timeout, ["--version"], {
    encoding: "utf8",
    timeout: 500,
    killSignal: "SIGKILL",
  });
  return (
    flockVersion.status === 0 &&
    String(flockVersion.stdout).includes("flock from util-linux") &&
    timeoutVersion.status === 0 &&
    String(timeoutVersion.stdout).includes("GNU coreutils")
  );
}

const realProvisioningPrimitives = hasRealProvisioningPrimitives();

function startProvisionWorker(
  bun: string,
  workspaceRoot: string,
  eventsPath: string,
) {
  const child = spawn(bun, [workerFixture, workspaceRoot], {
    cwd: workspaceRoot,
    env: { ...process.env, ACP_PROVISION_EVENTS: eventsPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const completion = new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `ACP provision worker failed (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
        ),
      );
    });
  });
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, completion, exit };
}

function runProvisionWorker(
  bun: string,
  workspaceRoot: string,
  eventsPath: string,
): Promise<void> {
  return startProvisionWorker(bun, workspaceRoot, eventsPath).completion;
}

async function waitForEvents(
  path: string,
  predicate: (events: string[]) => boolean,
): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
      : [];
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ACP provision events at ${path}`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeEventBuildScript(
  workspace: Workspace,
  partialDelaySeconds: string,
): void {
  writeFileSync(
    workspace.fakeBun,
    [
      "#!/bin/sh",
      'events="$ACP_PROVISION_EVENTS"',
      'metafile=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      `    --outfile=*) outfile="\${1#--outfile=}" ;;`,
      `    --metafile=*) metafile="\${1#--metafile=}" ;;`,
      "  esac",
      "  shift",
      "done",
      'printf "PARTIAL" > "$outfile"',
      'printf "build-partial:%s\\n" "$$" >> "$events"',
      `sleep ${partialDelaySeconds}`,
      'printf "// eliza-code-acp\\ncomplete:%s\\n" "$$" > "$outfile"',
      'printf \'{"inputs":{"src/acp.ts":{}}}\' > "$metafile"',
      'printf "build-complete:%s\\n" "$$" >> "$events"',
      "",
    ].join("\n"),
  );
  chmodSync(workspace.fakeBun, 0o755);
}

beforeEach(() => {
  process.env.PATH = originalPath;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalChildPidPath === undefined)
    delete process.env.ACP_TEST_CHILD_PID_PATH;
  else process.env.ACP_TEST_CHILD_PID_PATH = originalChildPidPath;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provisionWorkspaceElizaCodeAcp", () => {
  it("builds a private artifact once and publishes its runtime contract", () => {
    const workspace = makeWorkspace();
    const counter = { count: 0 };

    const result = provisionWithTestLease(workspace.root, {
      build: goodBuild(counter),
    });

    expect(result).toEqual({
      command: workspace.fakeBun,
      args: [workspace.output],
    });
    expect(counter.count).toBe(1);
    expect(readFileSync(workspace.output, "utf8")).toContain(ACP_MARKER);
    expect(readFileSync(join(workspace.distDir, "tsconfig.json"), "utf8")).toBe(
      '{\n  "compilerOptions": {}\n}\n',
    );
    expect(
      JSON.parse(readFileSync(join(workspace.distDir, ".acp.done"), "utf8")),
    ).toMatchObject({
      version: 2,
      outputHash: expect.any(String),
      inputHash: expect.any(String),
      inputFiles: expect.any(Array),
    });
  });

  it("reuses only an artifact tied to the complete local build inputs", () => {
    const workspace = makeWorkspace();
    const counter = { count: 0 };
    provisionWithTestLease(workspace.root, {
      build: goodBuild(counter),
    });
    provisionWithTestLease(workspace.root, {
      build: goodBuild(counter),
    });
    expect(counter.count).toBe(1);

    writeFileSync(
      join(workspace.packageDir, "src", "imported-helper.ts"),
      "export const changed = true;\n",
    );
    provisionWithTestLease(workspace.root, {
      build: goodBuild(counter),
    });
    expect(counter.count).toBe(2);

    writeFileSync(join(workspace.root, "bun.lock"), "lockfile-v2\n");
    provisionWithTestLease(workspace.root, {
      build: goodBuild(counter),
    });
    expect(counter.count).toBe(3);
  });

  it("detects artifact tampering even when size and timestamps are preserved", () => {
    const workspace = makeWorkspace();
    const counter = { count: 0 };
    provisionWithTestLease(workspace.root, {
      build: goodBuild(counter),
    });
    const before = statSync(workspace.output);
    const original = readFileSync(workspace.output, "utf8");
    const replacement = original.replace("complete", "tampered");
    expect(replacement).toHaveLength(original.length);
    writeFileSync(workspace.output, replacement);
    utimesSync(workspace.output, before.atime, before.mtime);

    provisionWithTestLease(workspace.root, {
      build: goodBuild(counter),
    });

    expect(counter.count).toBe(2);
    expect(readFileSync(workspace.output, "utf8")).toContain("complete");
  });

  it("rebuilds when a previously bundled input is deleted", () => {
    const workspace = makeWorkspace();
    const imported = join(workspace.packageDir, "src", "imported-helper.ts");
    writeFileSync(imported, "missing");
    let builds = 0;
    const build = ({ tmpOutput }: { tmpOutput: string }) => {
      builds += 1;
      writeFileSync(tmpOutput, `// ${ACP_MARKER}\ncomplete\n`);
      return {
        ok: true,
        detail: "",
        inputFiles: existsSync(imported)
          ? ["src/acp.ts", "src/imported-helper.ts"]
          : ["src/acp.ts"],
      };
    };
    provisionWithTestLease(workspace.root, { build });
    rmSync(imported);

    provisionWithTestLease(workspace.root, { build });

    expect(builds).toBe(2);
  });

  it("invalidates a marker that records a non-file workspace path", () => {
    const workspace = makeWorkspace();
    const counter = { count: 0 };
    provisionWithTestLease(workspace.root, {
      build: goodBuild(counter),
    });
    const markerPath = join(workspace.distDir, ".acp.done");
    const marker: Record<string, unknown> = JSON.parse(
      readFileSync(markerPath, "utf8"),
    );
    marker.inputFiles = ["."];
    writeFileSync(markerPath, JSON.stringify(marker));

    provisionWithTestLease(workspace.root, {
      build: goodBuild(counter),
    });

    expect(counter.count).toBe(2);
  });

  it("rejects a partial or marker-less build and never marks it fresh", () => {
    const workspace = makeWorkspace();
    expect(() =>
      provisionWithTestLease(workspace.root, {
        build: ({ tmpOutput }) => {
          writeFileSync(tmpOutput, "PARTIAL");
          return { ok: true, detail: "" };
        },
      }),
    ).toThrow(/failed validation/u);
    expect(existsSync(join(workspace.distDir, ".acp.done"))).toBe(false);

    const counter = { count: 0 };
    provisionWithTestLease(workspace.root, {
      build: goodBuild(counter),
    });
    expect(counter.count).toBe(1);
  });

  it("surfaces structured build failures without fabricating an artifact", () => {
    const workspace = makeWorkspace();
    let error: unknown;
    try {
      provisionWithTestLease(workspace.root, {
        build: () => ({
          ok: false,
          detail: "compiler failed",
          status: 2,
          signal: null,
          stdout: "out",
          stderr: "err",
        }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "ACP_PROVISIONING_BUILD_FAILED",
      context: expect.objectContaining({
        status: 2,
        stdout: "out",
        stderr: "err",
      }),
    });
    expect(existsSync(workspace.output)).toBe(false);
    expect(existsSync(join(workspace.distDir, ".acp.done"))).toBe(false);
  });

  it("fails if local inputs change while the bundle is being produced", () => {
    const workspace = makeWorkspace();
    expect(() =>
      provisionWithTestLease(workspace.root, {
        build: ({ tmpOutput }) => {
          writeFileSync(tmpOutput, `// ${ACP_MARKER}\ncomplete\n`);
          writeFileSync(
            join(workspace.packageDir, "src", "changed-during-build.ts"),
            "export {};\n",
          );
          return { ok: true, detail: "" };
        },
      }),
    ).toThrow(/inputs changed/u);
    expect(existsSync(join(workspace.distDir, ".acp.done"))).toBe(false);
  });

  it("does not let malformed stale diagnostics weaken the advisory lock", () => {
    const workspace = makeWorkspace();
    mkdirSync(workspace.distDir, { recursive: true });
    writeFileSync(join(workspace.distDir, ".acp.build.owner"), "partial-json");
    const counter = { count: 0 };

    provisionWithTestLease(workspace.root, {
      build: goodBuild(counter),
    });

    expect(counter.count).toBe(1);
    expect(existsSync(join(workspace.distDir, ".acp.build.owner"))).toBe(false);
  });

  it("ignores PID-reused owner metadata when no kernel lease exists", () => {
    const workspace = makeWorkspace();
    mkdirSync(workspace.distDir, { recursive: true });
    writeFileSync(
      join(workspace.distDir, ".acp.build.owner"),
      JSON.stringify({
        pid: process.pid,
        fence: "reused-owner-record",
        startedAtMs: Date.now(),
      }),
    );
    const counter = { count: 0 };

    provisionWithTestLease(workspace.root, {
      build: goodBuild(counter),
    });

    expect(counter.count).toBe(1);
    expect(existsSync(join(workspace.distDir, ".acp.build.owner"))).toBe(false);
  });

  it.skipIf(!realProvisioningPrimitives)(
    "runs one real build across concurrent processes and releases all waiters after completion",
    async () => {
      const workspace = makeWorkspace();
      const eventsPath = join(workspace.root, "concurrent-events.log");
      writeEventBuildScript(workspace, "0.3");
      const realBun = findRealBun();

      await Promise.all(
        Array.from({ length: 3 }, () =>
          runProvisionWorker(realBun, workspace.root, eventsPath),
        ),
      );

      const events = readFileSync(eventsPath, "utf8").trim().split("\n");
      expect(
        events.filter((event) => event.startsWith("build-partial:")),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.startsWith("build-complete:")),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.startsWith("returned:")),
      ).toHaveLength(3);
      const completedAt = events.findIndex((event) =>
        event.startsWith("build-complete:"),
      );
      expect(
        events
          .map((event, index) => ({ event, index }))
          .filter(({ event }) => event.startsWith("returned:"))
          .every(({ index }) => index > completedAt),
      ).toBe(true);
    },
  );

  it.skipIf(!realProvisioningPrimitives)(
    "recovers when the owner dies while its private builder survives",
    async () => {
      const workspace = makeWorkspace();
      const eventsPath = join(workspace.root, "owner-crash-events.log");
      writeEventBuildScript(workspace, "1.2");
      const realBun = findRealBun();
      const owner = startProvisionWorker(realBun, workspace.root, eventsPath);
      const ownerResult = owner.completion.catch((error: unknown) => error);
      await waitForEvents(eventsPath, (events) =>
        events.some((event) => event.startsWith("build-partial:")),
      );

      expect(owner.child.kill("SIGKILL")).toBe(true);
      expect(await owner.exit).toMatchObject({ signal: "SIGKILL" });
      const recoverers = Promise.all([
        runProvisionWorker(realBun, workspace.root, eventsPath),
        runProvisionWorker(realBun, workspace.root, eventsPath),
      ]);
      const overlappingEvents = await waitForEvents(
        eventsPath,
        (observed) =>
          observed.filter((event) => event.startsWith("build-partial:"))
            .length === 2,
      );
      const secondPartial = overlappingEvents.findIndex(
        (event, index) => index > 0 && event.startsWith("build-partial:"),
      );
      const firstComplete = overlappingEvents.findIndex((event) =>
        event.startsWith("build-complete:"),
      );
      expect(secondPartial).toBeGreaterThan(0);
      expect(firstComplete === -1 || secondPartial < firstComplete).toBe(true);
      await recoverers;
      expect(await ownerResult).toBeInstanceOf(Error);
      const events = await waitForEvents(
        eventsPath,
        (observed) =>
          observed.filter((event) => event.startsWith("build-complete:"))
            .length === 2,
      );

      expect(
        events.filter((event) => event.startsWith("build-partial:")),
      ).toHaveLength(2);
      expect(
        events.filter((event) => event.startsWith("returned:")),
      ).toHaveLength(2);
      expect(readFileSync(workspace.output, "utf8")).toContain("complete:");
    },
  );

  it.skipIf(!realProvisioningPrimitives)(
    "times out without stealing from a verified live advisory-lock owner",
    async () => {
      const workspace = makeWorkspace();
      const eventsPath = join(workspace.root, "live-owner-events.log");
      writeEventBuildScript(workspace, "1.0");
      const realBun = findRealBun();
      const owner = startProvisionWorker(realBun, workspace.root, eventsPath);
      await waitForEvents(eventsPath, (events) =>
        events.some((event) => event.startsWith("build-partial:")),
      );
      const ownerRecordBefore = readFileSync(
        join(workspace.distDir, ".acp.build.owner"),
        "utf8",
      );
      let waiterBuilt = false;
      let error: unknown;

      try {
        provisionWorkspaceElizaCodeAcp(workspace.root, {
          deadlineMs: 200,
          build: () => {
            waiterBuilt = true;
            return { ok: true, detail: "" };
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({ code: "ACP_PROVISIONING_LOCK_TIMEOUT" });
      expect(waiterBuilt).toBe(false);
      expect(
        readFileSync(join(workspace.distDir, ".acp.build.owner"), "utf8"),
      ).toBe(ownerRecordBefore);
      await owner.completion;
    },
  );

  it.skipIf(!realProvisioningPrimitives)(
    "kills a trapped builder and its descendants within the shared deadline",
    async () => {
      const workspace = makeWorkspace();
      const childPidPath = join(workspace.root, "builder-child.pid");
      process.env.ACP_TEST_CHILD_PID_PATH = childPidPath;
      writeFileSync(
        workspace.fakeBun,
        [
          "#!/bin/sh",
          "sleep 10 &",
          'printf "%s" "$!" > "$ACP_TEST_CHILD_PID_PATH"',
          "trap '' TERM",
          "while :; do :; done",
          "",
        ].join("\n"),
      );
      chmodSync(workspace.fakeBun, 0o755);
      const startedAt = performance.now();
      let error: unknown;

      try {
        provisionWorkspaceElizaCodeAcp(workspace.root, { deadlineMs: 200 });
      } catch (caught) {
        error = caught;
      }

      expect(performance.now() - startedAt).toBeLessThan(2_000);
      expect(error).toMatchObject({
        code: "ACP_PROVISIONING_BUILD_FAILED",
        context: expect.objectContaining({ timedOut: true }),
      });
      const childPid = Number(readFileSync(childPidPath, "utf8"));
      const childExitDeadline = Date.now() + 1_000;
      while (isPidAlive(childPid) && Date.now() < childExitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(isPidAlive(childPid)).toBe(false);
    },
  );

  it("bounds advisory-lock capability probing by the shared deadline", () => {
    const workspace = makeWorkspace();
    const fakeFlock = join(dirname(workspace.fakeBun), "flock");
    writeFileSync(fakeFlock, "#!/bin/sh\nwhile :; do :; done\n");
    chmodSync(fakeFlock, 0o755);
    const startedAt = performance.now();
    const result = provisionWorkspaceElizaCodeAcp(workspace.root, {
      deadlineMs: 200,
      build: goodBuild(),
    });

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(result).toBeUndefined();
    expect(existsSync(workspace.output)).toBe(false);
  });

  it("rejects an invalid shared deadline before opening a lock", () => {
    const workspace = makeWorkspace();
    expect(() =>
      provisionWorkspaceElizaCodeAcp(workspace.root, {
        deadlineMs: Number.NaN,
        build: goodBuild(),
      }),
    ).toThrow(/finite and positive/u);
    expect(existsSync(join(workspace.distDir, ".acp.build.guard"))).toBe(false);
  });

  it.skipIf(!realProvisioningPrimitives)(
    "does not start a builder without process-group termination budget",
    () => {
      const workspace = makeWorkspace();
      let nowCalls = 0;
      let error: unknown;
      try {
        provisionWorkspaceElizaCodeAcp(workspace.root, {
          deadlineMs: 200,
          now: () => {
            nowCalls += 1;
            return nowCalls >= 6 ? 140 : 0;
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({
        code: "ACP_PROVISIONING_BUILD_FAILED",
        context: expect.objectContaining({ timedOut: true }),
      });
      expect(existsSync(workspace.output)).toBe(false);
    },
  );

  it("carries one deadline from lock waiting into the build budget", () => {
    const workspace = makeWorkspace();
    let nowMs = 0;
    let attempts = 0;
    let observedBuildBudget = Number.NaN;

    provisionWorkspaceElizaCodeAcp(workspace.root, {
      deadlineMs: 200,
      now: () => nowMs,
      tryAcquireBuildLease: (_guardPath, timeoutMs) => {
        attempts += 1;
        if (attempts === 1) {
          expect(timeoutMs).toBe(200);
          nowMs = 150;
          return undefined;
        }
        expect(timeoutMs).toBe(50);
        return { release: () => undefined };
      },
      build: ({ timeoutMs, tmpOutput }) => {
        observedBuildBudget = timeoutMs;
        writeFileSync(tmpOutput, `// ${ACP_MARKER}\ncomplete\n`);
        return { ok: true, detail: "" };
      },
    });

    expect(attempts).toBe(2);
    expect(observedBuildBudget).toBe(50);
  });

  it("falls back when no proven advisory-lock primitive is available", () => {
    const workspace = makeWorkspace();
    process.env.PATH = dirname(workspace.fakeBun);
    expect(provisionWorkspaceElizaCodeAcp(workspace.root)).toBeUndefined();
  });

  it("falls back when the build supervisor is not GNU timeout", () => {
    const workspace = makeWorkspace();
    const fakeTimeout = join(dirname(workspace.fakeBun), "timeout");
    writeFileSync(fakeTimeout, '#!/bin/sh\necho "BusyBox timeout"\n');
    chmodSync(fakeTimeout, 0o755);

    expect(provisionWorkspaceElizaCodeAcp(workspace.root)).toBeUndefined();
    expect(existsSync(workspace.output)).toBe(false);
  });

  it("returns undefined when no workspace package or Bun exists", () => {
    const empty = makeTemp();
    process.env.PATH = "/definitely-not-a-bin-directory";
    expect(provisionWorkspaceElizaCodeAcp(empty)).toBeUndefined();
  });
});

describe("formatAcpCommand", () => {
  it("round-trips whitespace and either individual quote style", () => {
    const spaced = formatAcpCommand({
      command: "/opt/my bun/bin/bun",
      args: ["/work space/dist/acp.js"],
    });
    expect(splitCommandLine(spaced)).toEqual({
      command: "/opt/my bun/bin/bun",
      args: ["/work space/dist/acp.js"],
    });
    expect(
      splitCommandLine(
        formatAcpCommand({
          command: '/tmp/a"b/bun',
          args: ["/tmp/it's/acp.js"],
        }),
      ),
    ).toEqual({
      command: '/tmp/a"b/bun',
      args: ["/tmp/it's/acp.js"],
    });
  });

  it("fails closed when both quote styles make the grammar ambiguous", () => {
    expect(() =>
      formatAcpCommand({ command: `/tmp/a'"b/bun`, args: [] }),
    ).toThrow("both single and double quotes");
  });

  it("preserves a provisioned workspace path containing spaces", () => {
    const parent = makeTemp();
    const spacedRoot = join(parent, "workspace with space");
    const packageDir = join(spacedRoot, "packages", "examples", "code");
    const binDir = join(spacedRoot, "bin");
    mkdirSync(join(packageDir, "src"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(packageDir, "src", "acp.ts"), `// ${ACP_MARKER}\n`);
    const fakeBun = join(binDir, "bun");
    writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBun, 0o755);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const result = provisionWithTestLease(spacedRoot, {
      build: goodBuild(),
    });
    if (!result) throw new Error("expected workspace provisioning");
    expect(splitCommandLine(formatAcpCommand(result))).toEqual({
      command: fakeBun,
      args: [join(packageDir, "dist", "acp.js")],
    });
  });
});
