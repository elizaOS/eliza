import type { Command } from "commander";
import { theme } from "..//shared";

async function isPortListening(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 800,
): Promise<boolean> {
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

async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const bin = isMac ? "open" : isWin ? "cmd" : "xdg-open";
  // On Windows, `start` is a cmd built-in; the empty-string arg is the window title.
  const args = isWin ? ["/c", "start", "", url] : [url];
  const child = spawn(bin, args, { stdio: "ignore" });
  child.on("error", () => {
    console.log(theme.warn("Could not open browser automatically."));
    console.log(`${theme.muted("Open manually:")} ${url}`);
  });
  child.unref();
}

const DEFAULT_PORT = 2138;
const APP_DEV_PORT = 2138;

export function registerDashboardCommand(program: Command) {
  program
    .command("dashboard")
    .description("Open the Control UI in your browser")
    .option("--port <port>", "Server port to check", String(DEFAULT_PORT))
    .option("--url <url>", "Server URL (overrides --port)")
    .action(async (opts: { port?: string; url?: string }) => {
      const rawPort = Number(opts.port ?? DEFAULT_PORT);
      const port =
        Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535
          ? rawPort
          : DEFAULT_PORT;

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

      if (await isPortListening(APP_DEV_PORT)) {
        const url = `http://localhost:${APP_DEV_PORT}`;
        console.log(
          `${theme.muted("→")} Opening Control UI (dev server): ${url}`,
        );
        openInBrowser(url);
        return;
      }

      console.log(
        `${theme.muted("→")} Server not running on port ${port}; starting app dev server…`,
      );

      const path = await import("node:path");
      const fs = await import("node:fs");
      const { resolveElizaPackageRootSync } = await import(
        "../../utils/eliza-root"
      );

      const pkgRoot = resolveElizaPackageRootSync({
        cwd: process.cwd(),
        argv1: process.argv[1],
        moduleUrl: import.meta.url,
      });

      if (!pkgRoot) {
        console.log(theme.error("Could not locate eliza package root."));
        process.exitCode = 1;
        return;
      }

      const appDir = path.join(pkgRoot, "apps", "app");
      if (!fs.existsSync(path.join(appDir, "package.json"))) {
        console.log(
          theme.error("App UI is not available in this installation."),
        );
        console.log(
          theme.muted("The app dev server requires a development checkout."),
        );
        console.log(
          theme.muted(
            "Start the agent with `eliza start` and use the API at http://localhost:31337",
          ),
        );
        process.exitCode = 1;
        return;
      }

      const { spawn } = await import("node:child_process");
      const child = spawn("npx", ["vite"], {
        cwd: appDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let opened = false;

      const tryOpen = () => {
        if (opened) return;
        opened = true;
        const devUrl = `http://localhost:${APP_DEV_PORT}`;
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
        console.log(
          theme.error(`Failed to start app dev server: ${err.message}`),
        );
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
