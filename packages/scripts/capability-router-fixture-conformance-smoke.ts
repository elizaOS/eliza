import { type ChildProcessByStdio, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { runCapabilityRouterConformance } from "../app-core/src/cli/program/register.capability-router.ts";

type ReadyPayload = {
  baseUrl: string;
  token: string | null;
};

type FixtureServerProcess = ChildProcessByStdio<null, Readable, Readable>;
type BunBuildResult = {
  success: boolean;
  logs: unknown[];
};

const token = "fixture-smoke-token";
let child: FixtureServerProcess | null = null;
let workspace: string | null = null;

try {
  workspace = await mkdtemp(join(tmpdir(), "eliza-capability-router-fixture-"));
  const srcDir = join(workspace, "src");
  const distDir = join(workspace, "dist");
  await mkdir(srcDir, { recursive: true });
  await mkdir(distDir, { recursive: true });
  const viewSourcePath = join(srcDir, "fixture-view.ts");
  const builtBundlePath = join(distDir, "fixture-view.js");
  await writeFile(
    viewSourcePath,
    [
      "export const marker = 'fixture-built-remote-view';",
      "export const buildOrigin = 'capability-router-fixture-smoke';",
      "export function interact(input) {",
      "  return { marker, received: input };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const bunRuntime = globalThis as typeof globalThis & {
    Bun?: {
      build: (options: {
        entrypoints: string[];
        outdir?: string;
        target?: "browser" | "bun" | "node";
        format?: "esm" | "cjs" | "iife";
      }) => Promise<BunBuildResult>;
    };
  };
  if (!bunRuntime.Bun) {
    throw new Error("Fixture view build requires the Bun runtime.");
  }
  const buildResult = await bunRuntime.Bun.build({
    entrypoints: [viewSourcePath],
    outdir: distDir,
    target: "browser",
    format: "esm",
  });
  if (!buildResult.success) {
    throw new Error(
      `Fixture view build failed: ${JSON.stringify(buildResult.logs)}`,
    );
  }

  child = spawn(
    process.execPath,
    [
      "packages/scripts/capability-router-fixture-server.ts",
      "--token",
      token,
      "--asset-path",
      builtBundlePath,
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const ready = await readReadyPayload(child);
  const report = await runCapabilityRouterConformance(ready.baseUrl, {
    token,
    requestTimeoutMs: "10000",
  });
  const exercised = report.exercised as Record<string, unknown> | undefined;
  if (
    report.moduleCount !== 1 ||
    !exercised?.action ||
    !exercised.provider ||
    !exercised.route ||
    !exercised.viewAsset ||
    !exercised.model ||
    !exercised.lifecycle ||
    !exercised.event ||
    !exercised.service ||
    !exercised.appBridge ||
    !exercised.evaluator ||
    !exercised.responseHandlerEvaluator ||
    !exercised.responseHandlerFieldEvaluator
  ) {
    throw new Error(
      `Fixture conformance smoke returned partial report: ${JSON.stringify(report)}`,
    );
  }
  const bundleResponse = await fetch(
    `${ready.baseUrl}/v1/capabilities/assets/fixture-remote-plugin/assets/fixture-view.js`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!bundleResponse.ok) {
    throw new Error(
      `Fixture built view asset fetch failed with ${bundleResponse.status}`,
    );
  }
  const bundleSource = await bundleResponse.text();
  const imported = (await import(
    `data:text/javascript;base64,${Buffer.from(bundleSource).toString("base64")}`
  )) as {
    marker?: string;
    buildOrigin?: string;
    interact?: (input: unknown) => unknown;
  };
  if (
    imported.marker !== "fixture-built-remote-view" ||
    imported.buildOrigin !== "capability-router-fixture-smoke" ||
    typeof imported.interact !== "function"
  ) {
    throw new Error(
      `Fixture built view asset did not import as the expected module: ${JSON.stringify(
        imported,
      )}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl: ready.baseUrl,
        moduleIds: report.moduleIds,
        exercised,
        builtView: {
          marker: imported.marker,
          buildOrigin: imported.buildOrigin,
        },
      },
      null,
      2,
    ),
  );
} finally {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => undefined);
  }
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function readReadyPayload(
  process: FixtureServerProcess,
): Promise<ReadyPayload> {
  let stdout = "";
  let stderr = "";
  process.stdout.setEncoding("utf8");
  process.stderr.setEncoding("utf8");
  process.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  process.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for fixture server readiness. stdout=${stdout} stderr=${stderr}`,
        ),
      );
    }, 10_000);
  });
  const ready = new Promise<ReadyPayload>((resolve, reject) => {
    process.stdout.on("data", () => {
      const line = stdout
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find((item) => item.startsWith("{") && item.endsWith("}"));
      if (!line) return;
      try {
        const parsed = JSON.parse(line) as ReadyPayload;
        if (typeof parsed.baseUrl === "string") {
          resolve(parsed);
        }
      } catch (error) {
        reject(error);
      }
    });
    process.on("exit", (code, signal) => {
      reject(
        new Error(
          `Fixture server exited before ready: code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`,
        ),
      );
    });
    process.on("error", reject);
  });
  return Promise.race([ready, timeout]);
}
