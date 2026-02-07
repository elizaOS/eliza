#!/usr/bin/env node

const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const readline = require("readline");
const config = require("./config");
const { supportedClients } = require("./config");

function getPlatformInfo() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "win32" && arch === "x64")
    return {
      pkg: "computeruse-mcp-win32-x64-msvc",
      bin: "computeruse-mcp-agent.exe",
      npmDir: "win32-x64-msvc",
    };
  if (platform === "win32" && arch === "arm64")
    return {
      pkg: "computeruse-mcp-win32-arm64-msvc",
      bin: "computeruse-mcp-agent.exe",
      npmDir: "win32-arm64-msvc",
    };
  if (platform === "linux" && arch === "x64")
    return {
      pkg: "computeruse-mcp-linux-x64-gnu",
      bin: "computeruse-mcp-agent",
      npmDir: "linux-x64-gnu",
    };
  if (platform === "darwin" && arch === "x64")
    return {
      pkg: "computeruse-mcp-darwin-x64",
      bin: "computeruse-mcp-agent",
      npmDir: "darwin-x64",
    };
  if (platform === "darwin" && arch === "arm64")
    return {
      pkg: "computeruse-mcp-darwin-arm64",
      bin: "computeruse-mcp-agent",
      npmDir: "darwin-arm64",
    };
  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

function addToApp(app) {
  try {
    const client = (app || "").toLowerCase();
    const mcpServer = {
      command: "npx",
      args: ["-y", "computeruse-mcp-agent"],
    };
    const currentConfig = config.readConfig(client);
    currentConfig.mcpServers = currentConfig.mcpServers || {};
    currentConfig.mcpServers["computeruse-mcp-agent"] = mcpServer;
    config.writeConfig(currentConfig, client);
    console.log(`Configured MCP for ${client}`);
  } catch (e) {
    console.error(`Failed to configure MCP for ${app}:`, e.message);
    process.exit(1);
  }
}

const argv = process.argv.slice(2);

if (argv.includes("--add-to-app")) {
  const appIndex = argv.indexOf("--add-to-app") + 1;
  const app =
    argv[appIndex] && !argv[appIndex].startsWith("--")
      ? argv[appIndex]
      : undefined;
  if (!app) {
    // Interactive prompt
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    console.log("========== ComputerUse MCP Setup ==========");
    console.log("Which app do you want to configure ComputerUse MCP for?");
    console.log("");
    const pad = (n) =>
      String(n).padStart(String(supportedClients.length).length, " ");
    supportedClients.forEach((client, idx) => {
      console.log(`  ${pad(idx + 1)}. ${client.label}`);
    });
    console.log("");
    rl.question(
      `Enter your choice (1-${supportedClients.length}): `,
      (answer) => {
        const idx = parseInt(answer.trim(), 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= supportedClients.length) {
          console.error("Invalid choice. Skipping app configuration.");
          rl.close();
          process.exit(1);
        }
        const selectedApp = supportedClients[idx].key;
        rl.close();
        addToApp(selectedApp);
        process.exit(0);
      },
    );
    return;
  } else {
    addToApp(app);
    process.exit(0);
  }
} else {
  // Default: run the agent and forward arguments
  const packageInfo = require('./package.json');

  // Display version banner
  console.error(`🤖 ComputerUse MCP Agent v${packageInfo.version}`);
  console.error(`📦 Platform: ${process.platform}-${process.arch}`);
  console.error(`🚀 Starting MCP server...`);
  console.error(''); // Empty line for readability

  const { pkg, bin, npmDir } = getPlatformInfo();
  let binary;

  // 1. Try local build (for dev)
  const localPath = path.join(__dirname, "npm", npmDir, bin);
  if (fs.existsSync(localPath)) {
    binary = localPath;
    console.error(`🔧 Using local binary: ${path.relative(process.cwd(), binary)}`);
  } else {
    // 2. Try installed npm package
    try {
      binary = require.resolve(pkg);
      console.error(`📦 Using npm package: ${pkg}`);
    } catch (e) {
      console.error(`❌ Failed to find platform binary: ${pkg}`);
      process.exit(1);
    }
  }
  console.error(''); // Empty line before starting

  // Filter out --start if it exists, as it's for the wrapper script
  const agentArgs = argv.filter((arg) => arg !== "--start");

  // Set up environment variables for the child process
  const childEnv = {
    ...process.env,
    MCP_EXECUTION_MODE: process.env.MCP_EXECUTION_MODE || "local-copy",
  };

  let child = spawn(binary, agentArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
    env: childEnv,
  });

  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  function killProcess(proc) {
    if (!proc) return;
    const pid = proc.pid;
    if (process.platform === "win32") {
      try {
        execSync(`taskkill /PID ${pid} /T /F`);
      } catch (e) { }
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (e) { }
    }
  }

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (child && !child.killed) {
      if (child.stdin) child.stdin.end();
      const termTimeout = setTimeout(() => {
        if (!child.killed) {
          if (process.platform === "win32") {
            killProcess(child);
          } else {
            try {
              process.kill(child.pid, "SIGTERM");
            } catch (e) { }
            setTimeout(() => {
              if (!child.killed) killProcess(child);
            }, 2000);
          }
        }
      }, 2000);
      child.on("exit", () => clearTimeout(termTimeout));
    }
    process.exit();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", shutdown);

  let restartAttempts = 0;
  const MAX_RESTART_ATTEMPTS = 3;
  const RESTART_DELAY = 1000; // 1 second

  // Named function for exit handler so it can be reused
  function handleChildExit(code, signal) {
    // Check for stack overflow exit code on Windows (3221225725 = 0xC00000FD)
    const isStackOverflow = code === 3221225725 || code === -1073741571;

    // Restart if process exited abnormally (non-zero code or killed by signal)
    // Don't restart on normal exit (code === 0) or if we're shutting down
    // Note: code can be null when killed by signal, and signal is set
    const isAbnormalExit = code !== 0 || signal !== null;

    if (isAbnormalExit && !shuttingDown) {
      console.error(`[MCP exited with code ${code}${signal ? ` (signal: ${signal})` : ''}]`);

      // Auto-restart on crash if under max attempts
      if (restartAttempts < MAX_RESTART_ATTEMPTS) {
        restartAttempts++;

        if (isStackOverflow) {
          console.error(`[Stack overflow detected - this often happens with deeply nested UI trees]`);
        }

        console.error(`[Attempting to restart MCP server (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})...]`);

        setTimeout(() => {
          if (shuttingDown) {
            // Don't restart if we're shutting down
            return;
          }

          console.error(`[Restarting MCP server...]`);

          // Clean up old pipes safely
          try {
            if (child && child.stdin) {
              process.stdin.unpipe(child.stdin);
            }
          } catch (e) {
            // Ignore errors if pipes are already closed
          }

          // Spawn new process
          const newChild = spawn(binary, agentArgs, {
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
            detached: process.platform !== "win32",
            env: childEnv,
          });

          // Reconnect pipes
          try {
            process.stdin.pipe(newChild.stdin);
            newChild.stdout.pipe(process.stdout);
            newChild.stderr.pipe(process.stderr);
          } catch (e) {
            console.error(`[Error reconnecting pipes: ${e.message}]`);
            process.exit(1);
          }

          // Replace child reference
          child = newChild;

          // Reattach exit handler
          child.on("exit", handleChildExit);

          console.error(`[MCP server restarted successfully]`);
        }, RESTART_DELAY);

        return; // Don't exit the wrapper process
      } else {
        console.error(`[Max restart attempts reached. Exiting.]`);
      }
    }

    process.exit(code);
  }

  child.on("exit", handleChildExit);
}
