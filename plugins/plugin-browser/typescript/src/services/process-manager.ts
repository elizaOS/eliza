import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";

export class BrowserProcessManager {
  private process: ChildProcess | null = null;
  private isRunning = false;
  private binaryPath: string | null = null;

  constructor(private serverPort: number = 3456) {
    this.binaryPath = this.findBinary();
  }

  private getBinaryName(): { primary: string; fallback: string } {
    const platformName = platform();
    const arch = process.arch;
    const ext = platformName === "win32" ? ".exe" : "";

    return {
      primary: `browser-server-${platformName}-${arch}${ext}`,
      fallback: `browser-server-${platformName}${ext}`,
    };
  }

  private findBinary(): string | null {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const isDocker = process.env.DOCKER_CONTAINER === "true" || existsSync("/.dockerenv");
    const binaryNames = this.getBinaryName();

    const possiblePaths = [
      ...(isDocker
        ? [
            "/usr/local/bin/browser-server",
            "/usr/local/bin/browser-server-linux",
            "/app/browser-server",
            `/app/binaries/${binaryNames.primary}`,
            `/app/binaries/${binaryNames.fallback}`,
          ]
        : []),

      ...(!isDocker ? [join(moduleDir, "../server/dist/index.js")] : []),
      join(moduleDir, "../server/binaries", binaryNames.primary),
      join(moduleDir, "../server/binaries", binaryNames.fallback),
      join(moduleDir, "../../../browser-server", binaryNames.primary),
      join(moduleDir, "../../../browser-server", binaryNames.fallback),
      join(moduleDir, "../../.bin", "browser-server"),
      join(moduleDir, "../server/dist/index.js"),

      ...(isDocker
        ? ["/app/packages/plugin-browser/server/dist/index.js", "/app/browser-server/dist/index.js"]
        : []),
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        logger.info(`Found browser server at: ${path}`);
        return path;
      }
    }

    const srcPath = join(moduleDir, "../server/src/index.ts");
    if (existsSync(srcPath)) {
      logger.warn("No compiled binary found, will try to run from source with tsx");
      return srcPath;
    }

    logger.error("Could not find browser server binary or source files");
    logger.error(`Searched paths: ${possiblePaths.join(", ")}`);
    return null;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Browser server is already running");
      return;
    }

    if (!this.binaryPath) {
      throw new Error("Browser server binary not found - please ensure server is built");
    }

    const binaryPath = this.binaryPath;

    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        BROWSER_SERVER_PORT: this.serverPort.toString(),
        NODE_ENV: process.env.NODE_ENV ?? "production",
        BROWSERBASE_API_KEY: process.env.BROWSERBASE_API_KEY,
        BROWSERBASE_PROJECT_ID: process.env.BROWSERBASE_PROJECT_ID,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        BROWSER_HEADLESS: process.env.BROWSER_HEADLESS,
        CAPSOLVER_API_KEY: process.env.CAPSOLVER_API_KEY,
        OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? "http://ollama:11434",
        OLLAMA_MODEL: process.env.OLLAMA_MODEL ?? "llama3.2-vision",
        DISPLAY: process.env.DISPLAY ?? ":99",
      };

      const isBinary = !binaryPath.endsWith(".js") && !binaryPath.endsWith(".ts");
      const isTypeScript = binaryPath.endsWith(".ts");

      if (isBinary) {
        this.process = spawn(binaryPath, [], { env });
      } else if (isTypeScript) {
        const tsxPath = require.resolve("tsx/cli", { paths: [process.cwd()] });
        this.process = spawn("node", [tsxPath, binaryPath], { env });
      } else {
        this.process = spawn("node", [binaryPath], { env });
      }

      this.process.stdout?.on("data", (data: Buffer) => {
        const message = data.toString().trim();
        logger.debug(`[BrowserServer] ${message}`);

        if (message.includes("listening on port")) {
          this.isRunning = true;
          resolve();
        }
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        logger.error(`[BrowserServer Error] ${data.toString()}`);
      });

      this.process.on("error", (error: Error) => {
        logger.error(`Failed to start browser server: ${error.message}`);
        this.isRunning = false;
        reject(error);
      });

      this.process.on("exit", (code) => {
        logger.info(`Browser server exited with code ${code}`);
        this.isRunning = false;
      });

      this.waitForServer()
        .then(() => resolve())
        .catch((error) => {
          this.isRunning = false;
          if (this.process) {
            this.process.kill("SIGTERM");
          }
          reject(error);
        });
    });
  }

  private async waitForServer(): Promise<void> {
    const maxAttempts = 30;
    const delay = 1000;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const ws = require("ws");
        const wsConnection = new ws(`ws://localhost:${this.serverPort}`);

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            wsConnection.close();
            reject(new Error("Connection timeout"));
          }, 5000);

          wsConnection.on("open", () => {
            clearTimeout(timeout);
            wsConnection.close();
            resolve();
          });

          wsConnection.on("error", (error: Error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });

        logger.info("Browser server is ready");
        return;
      } catch {}

      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw new Error("Browser server failed to start");
  }

  async stop(): Promise<void> {
    if (!this.process || !this.isRunning) {
      return;
    }

    return new Promise((resolve) => {
      this.process?.on("exit", () => {
        this.isRunning = false;
        resolve();
      });

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
