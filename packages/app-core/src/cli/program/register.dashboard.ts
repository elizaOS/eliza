/**
 * Registers the `dashboard` CLI command, which opens the Control UI in the
 * browser. It probes the given `--port` (then the default) for a listening
 * server and opens that URL; failing that it locates the eliza package root,
 * spawns the app's Vite dev server, and opens the dev URL once Vite reports
 * "Local:" (or after a timeout). Cross-platform browser launch and dev-server
 * teardown are handled here: POSIX spawns the child detached and signals its
 * whole process group (SIGTERM, then SIGKILL) so no orphaned Vite grandchild
 * keeps holding the UI port; Windows tree-kills via taskkill /t /f.
 */
import { resolveDesktopUiPort, theme } from "@elizaos/shared";
import type { Command } from "commander";

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

export function registerDashboardCommand(program: Command) {
  const defaultPort = resolveDesktopUiPort(process.env);
  program
    .command("dashboard")
    .description("Open the Control UI in your browser")
    .option("--port <port>", "Server port to check", String(defaultPort))
    .option("--url <url>", "Server URL (overrides --port)")
    .action(async (opts: { port?: string; url?: string }) => {
      const rawPort = Number(opts.port ?? defaultPort);
      const port =
        Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535
          ? rawPort
          : defaultPort;

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

      if (port !== defaultPort && (await isPortListening(defaultPort))) {
        const url = `http://localhost:${defaultPort}`;
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

      const appDir = [
        path.join(pkgRoot, "packages", "app"),
        path.join(pkgRoot, "apps", "app"),
      ].find((candidate) =>
        fs.existsSync(path.join(candidate, "package.json")),
      );
      if (!appDir) {
        console.log(
          theme.error("App UI is not available in this installation."),
        );
        console.log(
          theme.muted("The app dev server requires a development checkout."),
        );
        console.log(
          theme.muted(
            "Start the agent with `eliza start` and use the URL printed at startup.",
          ),
        );
        process.exitCode = 1;
        return;
      }

      const { spawn, spawnSync } = await import("node:child_process");
      // On POSIX, `bun run dev` executes the `dev` script (Vite) as a separate
      // grandchild. `detached: true` makes the child the leader of its own
      // process group so cleanup() can signal the whole tree via the negative
      // PID. Windows keeps its default spawn behavior (`detached` there only
      // controls console attachment) and tears the tree down with taskkill /t.
      const child = spawn("bun", ["run", "dev"], {
        cwd: appDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        detached: process.platform !== "win32",
      });

      let opened = false;

      const tryOpen = () => {
        if (opened) return;
        opened = true;
        const devUrl = `http://localhost:${defaultPort}`;
        console.log(`${theme.muted("→")} Opening Control UI: ${devUrl}`);
        openInBrowser(devUrl);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        process.stdout.write(text);
        if (!opened && text.includes("Local:")) {
          tryOpen();
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk.toString());
      });

      child.on("error", (err) => {
        console.log(
          theme.error(`Failed to start app dev server: ${err.message}`),
        );
        process.exitCode = 1;
      });

      setTimeout(tryOpen, 10_000);

      // Signal the child's whole process group (negative PID) so the detached
      // `bun run dev` and its Vite grandchild both die. ESRCH means the group
      // is already gone; swallow it so we never crash the parent on shutdown.
      const killGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, signal);
        } catch (err) {
          // error-policy:J6 best-effort teardown: the group may already be gone
          // (ESRCH). Any other errno during shutdown is also non-actionable.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ESRCH") {
            console.log(
              theme.muted(`Dev server teardown (${signal}) skipped: ${code}`),
            );
          }
        }
      };

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (process.platform === "win32" && child.pid) {
          // Windows does not propagate SIGTERM through Bun's child tree.
          spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
          return;
        }
        killGroup("SIGTERM");
        // Escalate to SIGKILL after a short grace period if the group survives
        // a graceful SIGTERM (e.g. a wedged Vite worker ignoring the signal).
        const escalation = setTimeout(() => killGroup("SIGKILL"), 2_000);
        escalation.unref();
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
    });
}
