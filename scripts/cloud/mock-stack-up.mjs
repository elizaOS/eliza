#!/usr/bin/env node
/**
 * Eliza cloud — one-command local mock stack.
 *
 * Boots Hetzner mock, control-plane mock, cloud-api (with MOCK_REDIS + PGlite),
 * and cloud-frontend, wired together with auto-picked ports and health-check
 * gating. Streams each subprocess to ./.logs/<service>.log and the console
 * with a colored prefix. Ctrl+C triggers ordered graceful shutdown.
 */

import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const LOG_DIR = path.join(REPO_ROOT, ".logs");
const PGDATA_DIR = path.join(REPO_ROOT, ".eliza/.pgdata");

const USAGE = `Usage: bun scripts/cloud/mock-stack-up.mjs [flags]

Boots the local Eliza cloud mock stack (Hetzner mock + control-plane mock +
cloud-api with MOCK_REDIS + PGlite, optionally cloud-frontend) wired together.

Flags:
  --no-frontend         skip cloud-frontend
  --no-cp               skip control-plane mock
  --no-hetzner          skip hetzner mock
  --no-migrations       skip cloud-shared db:migrate
  --reset               wipe PGlite data dir before booting
  --port-frontend N     override frontend port
  --port-api N          override cloud-api port
  --port-cp N           override control-plane port
  --port-hetzner N      override hetzner port
  --help                print this usage
`;

function parseFlags(argv) {
  const flags = {
    noFrontend: false,
    noCp: false,
    noHetzner: false,
    noMigrations: false,
    reset: false,
    help: false,
    portFrontend: undefined,
    portApi: undefined,
    portCp: undefined,
    portHetzner: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--no-frontend":
        flags.noFrontend = true;
        break;
      case "--no-cp":
        flags.noCp = true;
        break;
      case "--no-hetzner":
        flags.noHetzner = true;
        break;
      case "--no-migrations":
        flags.noMigrations = true;
        break;
      case "--reset":
        flags.reset = true;
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--port-frontend":
        flags.portFrontend = Number.parseInt(argv[++i], 10);
        break;
      case "--port-api":
        flags.portApi = Number.parseInt(argv[++i], 10);
        break;
      case "--port-cp":
        flags.portCp = Number.parseInt(argv[++i], 10);
        break;
      case "--port-hetzner":
        flags.portHetzner = Number.parseInt(argv[++i], 10);
        break;
      default:
        return { error: `Unknown flag: ${a}` };
    }
  }
  return { flags };
}

const COLOR = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};
const color = (name, text) => `${COLOR[name] ?? ""}${text}${COLOR.reset}`;

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

async function waitForHttp(url, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status > 0) return true;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timeout waiting for ${url}: ${lastErr?.message ?? "no response"}`,
  );
}

const services = [];

function streamProcess(name, colorName, proc) {
  const logPath = path.join(LOG_DIR, `${name}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });
  const prefix = color(colorName, `[${name}]`);
  const tail = [];
  const pipe = (stream) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      logStream.write(chunk);
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        tail.push(line);
        if (tail.length > 100) tail.shift();
        process.stdout.write(`${prefix} ${line}\n`);
      }
    });
  };
  pipe(proc.stdout);
  pipe(proc.stderr);
  const entry = { name, color: colorName, proc, logPath, tail };
  services.push(entry);
  return entry;
}

async function shutdown(code = 0) {
  process.stdout.write(`${color("gray", "[stack]")} shutting down...\n`);
  for (const svc of [...services].reverse()) {
    if (svc.proc.exitCode === null && svc.proc.signalCode === null) {
      try {
        svc.proc.kill("SIGTERM");
      } catch {}
    }
  }
  const grace = setTimeout(() => {
    for (const svc of services) {
      if (svc.proc.exitCode === null && svc.proc.signalCode === null) {
        try {
          svc.proc.kill("SIGKILL");
        } catch {}
      }
    }
  }, 5_000);
  await Promise.all(
    services.map(
      (svc) =>
        new Promise((resolve) => {
          if (svc.proc.exitCode !== null || svc.proc.signalCode !== null)
            return resolve();
          svc.proc.once("exit", () => resolve());
        }),
    ),
  );
  clearTimeout(grace);
  process.stdout.write(`${color("gray", "[stack]")} stopped\n`);
  process.exit(code);
}

function dumpTail(svcName) {
  const svc = services.find((s) => s.name === svcName);
  if (!svc) return;
  process.stderr.write(`\n--- last 30 lines of ${svcName} ---\n`);
  for (const line of svc.tail.slice(-30)) process.stderr.write(`${line}\n`);
  process.stderr.write(`--- end ${svcName} ---\n`);
}

async function main() {
  const { flags, error } = parseFlags(process.argv.slice(2));
  if (error) {
    writeSync(1, `${error}\n\n${USAGE}`);
    process.exit(1);
  }
  if (flags.help) {
    writeSync(1, USAGE);
    process.exit(0);
  }

  mkdirSync(LOG_DIR, { recursive: true });
  if (flags.reset && existsSync(PGDATA_DIR)) {
    process.stdout.write(
      `${color("gray", "[stack]")} --reset: wiping ${PGDATA_DIR}\n`,
    );
    rmSync(PGDATA_DIR, { recursive: true, force: true });
  }
  mkdirSync(PGDATA_DIR, { recursive: true });

  const pickIfFalsy = async (v) =>
    v && Number.isFinite(v) ? v : await pickPort();
  const hetznerPort = await pickIfFalsy(
    flags.portHetzner ?? Number(process.env.HETZNER_PORT),
  );
  const cpPort = await pickIfFalsy(flags.portCp ?? Number(process.env.CP_PORT));
  const apiPort = await pickIfFalsy(
    flags.portApi ?? Number(process.env.API_PORT),
  );
  const frontendPort = await pickIfFalsy(
    flags.portFrontend ?? Number(process.env.FRONTEND_PORT),
  );

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  if (!flags.noMigrations) {
    process.stdout.write(
      `${color("gray", "[stack]")} running cloud-shared db:migrate...\n`,
    );
    const migrate = spawn(
      "bun",
      ["run", "--cwd", "packages/cloud-shared", "db:migrate"],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: `pglite://${PGDATA_DIR}` },
        stdio: "inherit",
      },
    );
    const code = await new Promise((res) => migrate.on("exit", (c) => res(c)));
    if (code !== 0) {
      process.stderr.write(`migrations failed (exit ${code})\n`);
      process.exit(1);
    }
  }

  const tHetzner = `http://127.0.0.1:${hetznerPort}`;
  const tCp = `http://127.0.0.1:${cpPort}`;
  const tApi = `http://127.0.0.1:${apiPort}`;
  const tFrontend = `http://127.0.0.1:${frontendPort}`;

  const baseEnv = {
    ...process.env,
    MOCK_REDIS: "1",
    DATABASE_URL: `pglite://${PGDATA_DIR}`,
    HCLOUD_API_BASE_URL: `${tHetzner}/v1`,
    HCLOUD_TOKEN: "local-mock-token",
    CONTAINER_CONTROL_PLANE_URL: tCp,
    CONTAINER_CONTROL_PLANE_TOKEN: "local-mock-token",
    CRON_SECRET: "local-cron-secret",
  };

  try {
    if (!flags.noHetzner) {
      const proc = spawn(
        "bun",
        [
          "run",
          "packages/test/cloud-mocks/bin/hetzner-mock.ts",
          "--port",
          String(hetznerPort),
        ],
        { cwd: REPO_ROOT, env: baseEnv },
      );
      streamProcess("hetzner", "cyan", proc);
      try {
        await waitForHttp(`${tHetzner}/`, { timeoutMs: 30_000 });
      } catch (e) {
        dumpTail("hetzner");
        throw new Error(`hetzner mock failed to start: ${e.message}`);
      }
    }

    if (!flags.noCp) {
      const proc = spawn(
        "bun",
        ["run", "packages/test/cloud-mocks/bin/control-plane-mock.ts"],
        {
          cwd: REPO_ROOT,
          env: {
            ...baseEnv,
            PORT: String(cpPort),
            HCLOUD_API_BASE_URL: `${tHetzner}/v1`,
          },
        },
      );
      streamProcess("cp", "magenta", proc);
      try {
        await waitForHttp(`${tCp}/`, { timeoutMs: 30_000 });
      } catch (e) {
        dumpTail("cp");
        throw new Error(`control-plane mock failed to start: ${e.message}`);
      }
    }

    {
      const proc = spawn("bun", ["run", "--cwd", "packages/cloud-api", "dev"], {
        cwd: REPO_ROOT,
        env: { ...baseEnv, API_DEV_PORT: String(apiPort) },
      });
      streamProcess("api", "yellow", proc);
      try {
        await waitForHttp(`${tApi}/`, { timeoutMs: 60_000 });
      } catch (e) {
        dumpTail("api");
        throw new Error(`cloud-api failed to start: ${e.message}`);
      }
    }

    if (!flags.noFrontend) {
      const proc = spawn(
        "bun",
        [
          "run",
          "--cwd",
          "packages/cloud-frontend",
          "dev",
          "--",
          "--port",
          String(frontendPort),
          "--strictPort",
        ],
        { cwd: REPO_ROOT, env: { ...baseEnv, VITE_API_URL: tApi } },
      );
      streamProcess("fe", "green", proc);
      try {
        await waitForHttp(`${tFrontend}/`, { timeoutMs: 60_000 });
      } catch (e) {
        dumpTail("fe");
        throw new Error(`cloud-frontend failed to start: ${e.message}`);
      }
    }
  } catch (e) {
    process.stderr.write(`\n${color("red", "[stack]")} ${e.message}\n`);
    await shutdown(1);
    return;
  }

  for (const svc of services) {
    svc.proc.on("exit", (code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") return;
      process.stderr.write(
        `\n${color("red", "[stack]")} ${svc.name} exited unexpectedly (code=${code}, signal=${signal})\n`,
      );
      void shutdown(1);
    });
  }

  const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
  const lines = [
    "┌────────────────────────────────────────────────────────────┐",
    `│ ${pad("Eliza cloud mock stack — ready", 58)} │`,
    "├────────────────────────────────────────────────────────────┤",
    `│ Frontend         ${pad(flags.noFrontend ? "(skipped)" : tFrontend, 41)} │`,
    `│ Cloud API        ${pad(tApi, 41)} │`,
    `│ Control plane    ${pad(flags.noCp ? "(skipped)" : tCp, 41)} │`,
    `│ Hetzner mock     ${pad(flags.noHetzner ? "(skipped)" : tHetzner, 41)} │`,
    `│ DB (PGlite)      ${pad("./.eliza/.pgdata", 41)} │`,
    `│ Redis            ${pad("in-memory (MOCK_REDIS=1)", 41)} │`,
    "└────────────────────────────────────────────────────────────┘",
    `Logs streaming to ${path.relative(REPO_ROOT, LOG_DIR)}/<service>.log`,
    "Ctrl+C to stop all.",
  ];
  process.stdout.write(`\n${lines.join("\n")}\n`);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.stack ?? e}\n`);
  void shutdown(1);
});
