import type { Command } from "commander";
import { theme } from "../../terminal/theme.js";

async function isPortListening(port: number, host = "127.0.0.1", timeoutMs = 800): Promise<boolean> {
  const net = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

function openInBrowser(url: string): void {
  import("node:child_process").then(({ exec }) => {
    const openCmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    exec(`${openCmd} ${url}`, (err) => {
      if (err) {
        console.log(theme.warn("Could not open browser automatically."));
        console.log(`${theme.muted("Open manually:")} ${url}`);
      }
    });
  });
}

const DEFAULT_PORT = 18789;
const CONTROL_UI_DEV_PORT = 2138;

export function registerDashboardCommand(program: Command) {
  program
    .command("dashboard")
    .description("Open the Control UI in your browser")
    .option("--port <port>", "Server port to check", String(DEFAULT_PORT))
    .option("--url <url>", "Server URL (overrides --port)")
    .action(async (opts: { port?: string; url?: string }) => {
      const port = Number(opts.port ?? DEFAULT_PORT);

      if (opts.url) {
        console.log(`${theme.muted("→")} Opening Control UI: ${opts.url}`);
        openInBrowser(opts.url);
        return;
      }

      if (await isPortListening(port)) {
        const url = `http://localhost:${port}`;
        console.log(`${theme.muted("→")} Opening Control UI: ${url}`);
        openInBrowser(url);
        return;
      }

      if (await isPortListening(CONTROL_UI_DEV_PORT)) {
        const url = `http://localhost:${CONTROL_UI_DEV_PORT}`;
        console.log(`${theme.muted("→")} Opening Control UI (dev server): ${url}`);
        openInBrowser(url);
        return;
      }

      console.log(
        `${theme.muted("→")} Server not running on port ${port}; starting Control UI dev server…`,
      );

      const path = await import("node:path");
      const fs = await import("node:fs");
      const { resolveMilaidyPackageRootSync } = await import("../../utils/milaidy-root.js");

      const pkgRoot = resolveMilaidyPackageRootSync({
        cwd: process.cwd(),
        argv1: process.argv[1],
        moduleUrl: import.meta.url,
      });

      if (!pkgRoot) {
        console.log(theme.error("Could not locate milaidy package root."));
        process.exitCode = 1;
        return;
      }

      const uiDir = path.join(pkgRoot, "apps", "ui");
      if (!fs.existsSync(path.join(uiDir, "package.json"))) {
        console.log(theme.error(`Control UI not found at ${uiDir}`));
        process.exitCode = 1;
        return;
      }

      const uiScript = path.join(pkgRoot, "scripts", "ui.js");
      const { spawn } = await import("node:child_process");
      const child = spawn("node", [uiScript, "dev"], {
        cwd: pkgRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let opened = false;

      const tryOpen = () => {
        if (opened) return;
        opened = true;
        const devUrl = `http://localhost:${CONTROL_UI_DEV_PORT}`;
        console.log(`${theme.muted("→")} Opening Control UI: ${devUrl}`);
        openInBrowser(devUrl);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        process.stdout.write(text);
        if (!opened && text.includes("Local:")) {
          tryOpen();
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk.toString());
      });

      child.on("error", (err) => {
        console.log(theme.error(`Failed to start UI dev server: ${err.message}`));
        process.exitCode = 1;
      });

      setTimeout(tryOpen, 10_000);

      const cleanup = () => {
        child.kill("SIGTERM");
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
    });
}
