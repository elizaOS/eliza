#!/usr/bin/env bun

/**
 * Integration-test launcher for Feed against a running web server.
 * It manages server readiness, isolated workspaces, and optional test discovery for the app integration lane.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const rootDir = path.resolve(import.meta.dir, "..");
const appDir = path.join(rootDir, "apps/web");
const requestedBaseUrl =
  process.env.TEST_BASE_URL ||
  process.env.TEST_API_URL ||
  "http://127.0.0.1:3100";
const requestedUrl = new URL(requestedBaseUrl);
const serverHostname = requestedUrl.hostname;
const serverPort =
  requestedUrl.port || (requestedUrl.protocol === "https:" ? "443" : "80");
const includeOptionalIntegrationTests =
  process.env.RUN_OPTIONAL_INTEGRATION_TESTS === "1";
const portReservationDir = path.join(tmpdir(), "feed-integration-server-ports");
const optionalIntegrationTestMatchers = [
  /agent-actions-persistence\.integration\.test\.ts$/,
  /agent0-localnet\.test\.ts$/,
  /agent0-sdk\.integration\.test\.ts$/,
  /db-lazy-connection\.integration\.test\.ts$/,
  /engine-generation-output\.test\.ts$/,
  /full-agent-tick\.test\.ts$/,
  /full-production-tick\.test\.ts$/,
  /trading-and-questions\.integration\.test\.ts$/,
  /reputation-localnet-keys\.test\.ts$/,
  /-localnet\.test\.ts$/,
  /\.localnet\.test\.ts$/,
];

type PortReservation = {
  port: number;
  lockPath: string;
};

type IsolatedWorkspace = {
  workspaceDir: string;
  appDir: string;
};

const testStewardAuthPattern =
  /Authorization[\s\S]{0,200}steward:test:|Bearer steward:test:/;

async function isServerReady(
  serverBaseUrl: string,
  timeoutMs: number = 30_000,
): Promise<boolean> {
  try {
    const response = await fetch(`${serverBaseUrl}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function supportsTestStewardAuth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/waitlist/bonus/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer steward:test:123456789012345",
      },
      body: JSON.stringify({ email: "probe@example.com" }),
      signal: AbortSignal.timeout(10_000),
    });

    return response.status !== 401;
  } catch {
    return false;
  }
}

async function warmSwaggerRoutes(baseUrl: string) {
  for (const route of ["/api/docs", "/api-docs"]) {
    const response = await fetch(`${baseUrl}${route}`, {
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(
        `Failed to warm ${route} at ${baseUrl}: ${response.status}`,
      );
    }
  }
}

async function isPortAvailable(
  hostname: string,
  port: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();

    server.once("error", () => resolve(false));
    server.listen({ host: hostname, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

function reservePort(hostname: string, port: number): PortReservation | null {
  mkdirSync(portReservationDir, { recursive: true });

  const reservationPath = path.join(
    portReservationDir,
    `${hostname.replace(/[^a-zA-Z0-9.-]/g, "_")}-${port}.json`,
  );

  try {
    writeFileSync(
      reservationPath,
      JSON.stringify({
        pid: process.pid,
        hostname,
        port,
        reservedAt: Date.now(),
      }),
      { flag: "wx" },
    );

    return { port, lockPath: reservationPath };
  } catch (error) {
    const reservationError = error as NodeJS.ErrnoException;
    if (reservationError.code !== "EEXIST") {
      throw error;
    }

    try {
      const existingReservation = JSON.parse(
        readFileSync(reservationPath, "utf-8"),
      ) as { pid?: number } | null;

      if (
        typeof existingReservation?.pid === "number" &&
        !isProcessAlive(existingReservation.pid)
      ) {
        rmSync(reservationPath, { force: true });
        return reservePort(hostname, port);
      }
    } catch {
      rmSync(reservationPath, { force: true });
      return reservePort(hostname, port);
    }

    return null;
  }
}

function releasePortReservation(reservation: PortReservation | null) {
  if (reservation) {
    rmSync(reservation.lockPath, { force: true });
  }
}

function prepareIsolatedWorkspace(port: number): IsolatedWorkspace {
  const workspaceDir = mkdtempSync(
    path.join(tmpdir(), `feed-integration-workspace-${port}-`),
  );
  const isolatedAppDir = path.join(workspaceDir, "apps", "web");
  const appNodeModulesPath = path.join(appDir, "node_modules");
  const rootEntriesToLink = [
    "node_modules",
    "packages",
    "package.json",
    "bun.lock",
    "turbo.json",
    "tsconfig.json",
    "tsconfig.build.json",
    ".env",
    ".env.local",
    ".env.production.local",
  ];

  mkdirSync(path.dirname(isolatedAppDir), { recursive: true });

  cpSync(appDir, isolatedAppDir, {
    recursive: true,
    dereference: false,
    filter: (sourcePath) => {
      const baseName = path.basename(sourcePath);

      if (
        baseName === "node_modules" ||
        baseName === "dist" ||
        baseName === ".turbo" ||
        baseName === ".next" ||
        baseName.startsWith(".next-")
      ) {
        return false;
      }

      return true;
    },
  });

  if (existsSync(appNodeModulesPath)) {
    symlinkSync(
      appNodeModulesPath,
      path.join(isolatedAppDir, "node_modules"),
      "dir",
    );
  }

  for (const entry of rootEntriesToLink) {
    const sourcePath = path.join(rootDir, entry);
    if (!existsSync(sourcePath)) {
      continue;
    }

    symlinkSync(
      sourcePath,
      path.join(workspaceDir, entry),
      statSync(sourcePath).isDirectory() ? "dir" : "file",
    );
  }

  return {
    workspaceDir,
    appDir: isolatedAppDir,
  };
}

function collectTestFiles(targets: string[]): string[] {
  const files: string[] = [];

  const walk = (targetPath: string) => {
    for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
      const entryPath = path.join(targetPath, entry.name);

      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(entryPath);
      }
    }
  };

  for (const target of targets) {
    const resolvedTarget = path.resolve(rootDir, target);
    if (!existsSync(resolvedTarget)) {
      continue;
    }

    const targetStats = statSync(resolvedTarget);
    if (targetStats.isDirectory()) {
      walk(resolvedTarget);
      continue;
    }

    if (targetStats.isFile()) {
      files.push(resolvedTarget);
    }
  }

  return files;
}

function isOptionalIntegrationTest(filePath: string): boolean {
  const normalizedPath = filePath.replaceAll(path.sep, "/");
  return optionalIntegrationTestMatchers.some((matcher) =>
    matcher.test(normalizedPath),
  );
}

function requiresTestStewardAuth(targets: string[]): boolean {
  for (const filePath of collectTestFiles(targets)) {
    if (testStewardAuthPattern.test(readFileSync(filePath, "utf-8"))) {
      return true;
    }
  }

  return false;
}

async function findAvailablePort(
  hostname: string,
  preferredPort: number,
): Promise<PortReservation> {
  for (let port = preferredPort; port < preferredPort + 20; port += 1) {
    if (await isPortAvailable(hostname, port)) {
      const reservation = reservePort(hostname, port);
      if (reservation) {
        return reservation;
      }
    }
  }

  throw new Error(
    `Unable to find an available port for integration server starting at ${preferredPort}`,
  );
}

async function waitForServer(
  server: ChildProcessWithoutNullStreams,
  serverBaseUrl: string,
) {
  const deadline = Date.now() + 300_000;
  let stdoutBuffer = "";
  let stderrBuffer = "";

  server.stdout.on("data", (chunk) => {
    stdoutBuffer = (stdoutBuffer + chunk.toString()).slice(-12000);
  });
  server.stderr.on("data", (chunk) => {
    stderrBuffer = (stderrBuffer + chunk.toString()).slice(-12000);
  });

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(
        `Integration test server exited early with code ${server.exitCode}\n` +
          stdoutBuffer +
          "\n" +
          stderrBuffer,
      );
    }

    if (await isServerReady(serverBaseUrl, 10_000)) {
      return;
    }

    await delay(1000);
  }

  throw new Error(
    `Timed out waiting for integration test server at ${serverBaseUrl}\n` +
      stdoutBuffer +
      "\n" +
      stderrBuffer,
  );
}

async function stopServer(server: ChildProcessWithoutNullStreams) {
  if (server.exitCode !== null) {
    return;
  }

  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const forceKillTimer = setTimeout(() => {
      server.kill("SIGKILL");
    }, 5000);

    server.once("exit", () => {
      clearTimeout(forceKillTimer);
      resolve();
    });
  });
}

async function runTestFile(filePath: string, env: NodeJS.ProcessEnv) {
  const relativeFilePath = path.relative(rootDir, filePath);
  const proc = spawn(
    "bun",
    [
      "test",
      "--preload",
      "./packages/testing/integration/preload.ts",
      "--max-concurrency",
      "1",
      relativeFilePath,
    ],
    {
      cwd: rootDir,
      env,
      stdio: "inherit",
    },
  );

  const heartbeat = setInterval(() => {
    console.log(`⏳ Still running: ${relativeFilePath}`);
  }, 5000);

  return await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code) => {
      clearInterval(heartbeat);
      resolve(code ?? 1);
    });
  });
}

async function runWithOwnedServer(
  filePath: string,
  hostname: string,
  preferredPort: number,
) {
  const portReservation = await findAvailablePort(hostname, preferredPort);
  const effectiveBaseUrl = `${requestedUrl.protocol}//${hostname}:${portReservation.port}`;
  const isolatedWorkspace = prepareIsolatedWorkspace(portReservation.port);
  const sharedEnv = {
    ...process.env,
    TEST_BASE_URL: effectiveBaseUrl,
    TEST_API_URL: effectiveBaseUrl,
    DISABLE_RATE_LIMITING: "true",
    ALLOW_TEST_STEWARD_AUTH: "true",
    PERP_SETTLEMENT_MODE: "simulation",
    NEXT_PUBLIC_PERP_SETTLEMENT_MODE: "simulation",
  };

  console.warn(
    `🧪 Starting isolated integration server at ${effectiveBaseUrl}`,
  );

  const server = spawn(
    "bunx",
    [
      "next",
      "dev",
      "--webpack",
      "--hostname",
      hostname,
      "--port",
      `${portReservation.port}`,
    ],
    {
      cwd: isolatedWorkspace.appDir,
      env: {
        ...sharedEnv,
      },
      stdio: "pipe",
    },
  );

  try {
    await waitForServer(server, effectiveBaseUrl);
    if (path.basename(filePath) === "swagger.integration.test.ts") {
      await warmSwaggerRoutes(effectiveBaseUrl);
    }
    return await runTestFile(filePath, sharedEnv);
  } finally {
    await stopServer(server);
    releasePortReservation(portReservation);
    rmSync(isolatedWorkspace.workspaceDir, { recursive: true, force: true });
  }
}

async function main() {
  const hasExplicitTargets = process.argv.length > 2;
  const testTargets = hasExplicitTargets
    ? process.argv.slice(2)
    : ["packages/testing/integration/"];
  let testFiles = [...new Set(collectTestFiles(testTargets))].sort();
  if (!hasExplicitTargets && !includeOptionalIntegrationTests) {
    testFiles = testFiles.filter(
      (filePath) => !isOptionalIntegrationTest(filePath),
    );
  }
  const hasExplicitBaseUrl =
    process.env.TEST_BASE_URL !== undefined ||
    process.env.TEST_API_URL !== undefined;
  const needsTestStewardAuth = requiresTestStewardAuth(testTargets);
  const explicitServerReady =
    hasExplicitBaseUrl && (await isServerReady(requestedBaseUrl, 10_000));
  const canReuseServer =
    explicitServerReady &&
    (!needsTestStewardAuth ||
      (await supportsTestStewardAuth(requestedBaseUrl)));

  if (explicitServerReady && needsTestStewardAuth && !canReuseServer) {
    throw new Error(
      `Explicit integration server at ${requestedBaseUrl} does not support test Steward auth`,
    );
  }

  if (testFiles.length === 0) {
    throw new Error(
      `No integration test files found for targets: ${testTargets.join(", ")}`,
    );
  }

  if (!hasExplicitTargets && !includeOptionalIntegrationTests) {
    const excludedCount =
      collectTestFiles(testTargets).length - testFiles.length;
    if (excludedCount > 0) {
      console.log(
        `ℹ️ Excluding ${excludedCount} optional integration files from the default deterministic suite`,
      );
    }
  }

  const requestedPortNumber = Number(serverPort);

  if (canReuseServer) {
    console.log(`♻️ Reusing integration server at ${requestedBaseUrl}`);
  }

  for (const filePath of testFiles) {
    console.log(
      `\n🧪 Running integration file: ${path.relative(rootDir, filePath)}`,
    );

    const exitCode = canReuseServer
      ? await runTestFile(filePath, {
          ...process.env,
          TEST_BASE_URL: requestedBaseUrl,
          TEST_API_URL: requestedBaseUrl,
          DISABLE_RATE_LIMITING: "true",
          ALLOW_TEST_STEWARD_AUTH: "true",
          PERP_SETTLEMENT_MODE: "simulation",
          NEXT_PUBLIC_PERP_SETTLEMENT_MODE: "simulation",
        })
      : await runWithOwnedServer(filePath, serverHostname, requestedPortNumber);

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
}

await main();
