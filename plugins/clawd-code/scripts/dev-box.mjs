import { spawn } from "node:child_process";

const children = [];
let shuttingDown = false;

function prefix(name, data, stream) {
  for (const line of data.toString().split(/\r?\n/)) {
    if (line) stream.write(`[${name}] ${line}\n`);
  }
}

function start(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  children.push(child);
  child.stdout.on("data", (data) => prefix(name, data, process.stdout));
  child.stderr.on("data", (data) => prefix(name, data, process.stderr));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const other of children) {
      if (other !== child && !other.killed) other.kill("SIGTERM");
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

start("api", "npm", ["run", "api:dev"]);
start("web", "npm", ["--prefix", "web", "run", "dev"], {
  NEXT_PUBLIC_API_URL: apiUrl,
  CLAWD_API_URL: process.env.CLAWD_API_URL ?? apiUrl,
});
