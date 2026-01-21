import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";

export class MinecraftProcessManager {
  private process: ChildProcess | null = null;
  private isRunning = false;
  private entryPath: string | null = null;

  constructor(private serverPort: number) {
    this.entryPath = this.findEntry();
  }

  private findEntry(): string | null {
    const moduleDir = dirname(fileURLToPath(import.meta.url));

    const possible = [
      // monorepo dev path
      join(moduleDir, "../../../mineflayer-server/dist/index.js"),
      join(moduleDir, "../../../mineflayer-server/src/index.ts"),
      // installed package layout
      join(moduleDir, "../../../../mineflayer-server/dist/index.js"),
      join(moduleDir, "../../../../mineflayer-server/src/index.ts"),
    ];

    for (const p of possible) {
      if (existsSync(p)) {
        logger.info(`Found mineflayer-server entry at: ${p}`);
        return p;
      }
    }

    logger.error("Could not find mineflayer-server entry file");
    logger.error(`Searched paths: ${possible.join(", ")}`);
    return null;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    if (!this.entryPath) {
      throw new Error(
        "mineflayer-server entry not found (run: bun run build:server)",
      );
    }

    const env = {
      ...process.env,
      MC_SERVER_PORT: this.serverPort.toString(),
      NODE_ENV: process.env.NODE_ENV ?? "production",
    };

    const entry = this.entryPath;
    const isTypeScript = entry.endsWith(".ts");

    return await new Promise((resolve, reject) => {
      if (isTypeScript) {
        const require = createRequire(import.meta.url);
        const tsxPath = require.resolve("tsx/cli", { paths: [process.cwd()] });
        this.process = spawn("node", [tsxPath, entry], { env });
      } else {
        this.process = spawn("node", [entry], { env });
      }

      this.process.stdout?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        logger.debug(`[MinecraftServer] ${msg}`);
        if (msg.includes("listening on port")) {
          this.isRunning = true;
          resolve();
        }
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        logger.error(`[MinecraftServer Error] ${data.toString()}`);
      });

      this.process.on("error", (err) => {
        this.isRunning = false;
        reject(err);
      });

      this.process.on("exit", (code) => {
        logger.info(
          `Minecraft server process exited with code ${code ?? "unknown"}`,
        );
        this.isRunning = false;
      });

      // If stdout doesn't include the readiness line, rely on a timeout.
      setTimeout(() => {
        if (!this.isRunning) {
          reject(new Error("mineflayer-server failed to start (timeout)"));
        }
      }, 15_000);
    });
  }

  async stop(): Promise<void> {
    if (!this.process || !this.isRunning) return;
    await new Promise<void>((resolve) => {
      this.process?.on("exit", () => resolve());
      this.process?.kill("SIGTERM");
      setTimeout(() => {
        if (this.isRunning && this.process) {
          this.process.kill("SIGKILL");
        }
      }, 5000);
    });
  }

  isServerRunning(): boolean {
    return this.isRunning;
  }

  getServerUrl(): string {
    return `ws://localhost:${this.serverPort}`;
  }
}
