#!/usr/bin/env -S node --import tsx
import { execSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const DEFAULT_PORT = 18789;

export interface PortProcess {
  pid: string;
  command: string;
}

function forceFreePort(port: number): PortProcess[] {
  if (process.platform === "win32") {
    try {
      const out = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      const processes = Array.from(
        new Set(
          out
            .split("\n")
            .map((line) => line.trim().split(/\s+/).pop())
            .filter((pid): pid is string => Boolean(pid)),
        ),
      ).map((pid) => ({ pid, command: "LISTENING" }));

      for (const processInfo of processes) {
        try {
          execSync(`taskkill /F /PID ${processInfo.pid}`, { stdio: "ignore" });
        } catch {
          // Ignore races where the process exits between discovery and kill.
        }
      }

      return processes;
    } catch {
      return [];
    }
  }

  try {
    const pidOutput = execSync(`lsof -ti :${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const pids = Array.from(
      new Set(
        pidOutput
          .split("\n")
          .map((pid) => pid.trim())
          .filter((pid) => pid.length > 0),
      ),
    );
    const processes = pids.map((pid) => {
      let command = "unknown";
      try {
        command = execSync(`ps -o comm= -p ${pid}`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
        }).trim();
      } catch {
        // Fall back to the default command label if ps lookup fails.
      }
      return { pid, command };
    });

    for (const processInfo of processes) {
      try {
        execSync(`kill -9 ${processInfo.pid}`, { stdio: "ignore" });
      } catch {
        // Ignore races where the process exits between discovery and kill.
      }
    }

    return processes;
  } catch {
    return [];
  }
}

function killGatewayListeners(port: number): PortProcess[] {
  try {
    const killed = forceFreePort(port);
    if (killed.length > 0) {
      console.log(
        `freed port ${port}; terminated: ${killed
          .map((p) => `${p.command} (pid ${p.pid})`)
          .join(", ")}`,
      );
    } else {
      console.log(`port ${port} already free`);
    }
    return killed;
  } catch (err) {
    console.error(`failed to free port ${port}: ${String(err)}`);
    return [];
  }
}

function runTests() {
  const isolatedLock =
    process.env.ELIZA_GATEWAY_LOCK ??
    path.join(os.tmpdir(), `eliza-gateway.lock.test.${Date.now()}`);
  const result = spawnSync("bun", ["run", "vitest", "run"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ELIZA_GATEWAY_LOCK: isolatedLock,
    },
  });
  if (result.error) {
    console.error(`bun test failed to start: ${String(result.error)}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

function main() {
  const port = Number.parseInt(
    process.env.ELIZA_GATEWAY_PORT ?? `${DEFAULT_PORT}`,
    10,
  );

  console.log(`🧹 test:force - clearing gateway on port ${port}`);
  const killed = killGatewayListeners(port);
  if (killed.length === 0) {
    console.log("no listeners to kill");
  }

  console.log("running bun test…");
  runTests();
}

main();
