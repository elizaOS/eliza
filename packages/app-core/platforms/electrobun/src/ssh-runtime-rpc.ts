/** Native SSH-agent tunnel lifecycle for Advanced remote runtime enrollment. */
import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";

interface SshRuntimeParams {
  runtimeId: string;
  target: string;
  sshPort: number;
  remoteApiPort: number;
  identityFile?: string;
}

const tunnels = new Map<string, ChildProcess>();
const TARGET_PATTERN = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/;

function parseParams(params: unknown): SshRuntimeParams {
  if (!params || typeof params !== "object") {
    throw new Error("SSH runtime params must be an object");
  }
  const runtimeId = Reflect.get(params, "runtimeId");
  const target = Reflect.get(params, "target");
  const sshPort = Reflect.get(params, "sshPort");
  const remoteApiPort = Reflect.get(params, "remoteApiPort");
  const identityFile = Reflect.get(params, "identityFile");
  if (
    typeof runtimeId !== "string" ||
    !runtimeId.trim() ||
    runtimeId.length > 256 ||
    typeof target !== "string" ||
    !TARGET_PATTERN.test(target) ||
    !Number.isInteger(sshPort) ||
    sshPort < 1 ||
    sshPort > 65_535 ||
    !Number.isInteger(remoteApiPort) ||
    remoteApiPort < 1 ||
    remoteApiPort > 65_535 ||
    (identityFile !== undefined &&
      (typeof identityFile !== "string" ||
        !identityFile.startsWith("/") ||
        identityFile.length > 4096))
  ) {
    throw new Error("SSH runtime fields are invalid");
  }
  return {
    runtimeId: runtimeId.trim(),
    target,
    sshPort,
    remoteApiPort,
    ...(identityFile ? { identityFile } : {}),
  };
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error || !port)
          reject(error ?? new Error("Could not reserve a local port"));
        else resolve(port);
      });
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const fail = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", fail);
    socket.once("timeout", fail);
  });
}

async function waitForTunnel(
  child: ChildProcess,
  localPort: number,
  readSpawnError: () => Error | null,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const spawnError = readSpawnError();
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) {
      throw new Error("SSH exited before the private tunnel was ready");
    }
    if (await canConnect(localPort)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("SSH authentication or tunnel setup timed out");
}

export async function desktopStartSshRuntime(
  params: unknown,
): Promise<{ apiBase: string; localPort: number }> {
  const input = parseParams(params);
  const prior = tunnels.get(input.runtimeId);
  if (prior && prior.exitCode === null) prior.kill("SIGTERM");
  const localPort = await reserveLoopbackPort();
  const args = [
    "-N",
    "-T",
    "-p",
    String(input.sshPort),
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${input.remoteApiPort}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=8",
    ...(input.identityFile ? ["-i", input.identityFile] : []),
    "--",
    input.target,
  ];
  const child = spawn(
    process.platform === "win32" ? "ssh" : "/usr/bin/ssh",
    args,
    {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });
  try {
    await waitForTunnel(child, localPort, () => spawnError);
  } catch (error) {
    child.kill("SIGTERM");
    const detail = stderr.trim();
    throw new Error(
      detail
        ? `SSH tunnel failed: ${detail}`
        : error instanceof Error
          ? error.message
          : "SSH tunnel failed",
    );
  }
  tunnels.set(input.runtimeId, child);
  child.once("exit", () => {
    if (tunnels.get(input.runtimeId) === child) tunnels.delete(input.runtimeId);
  });
  return { apiBase: `http://127.0.0.1:${localPort}`, localPort };
}

export async function desktopStopSshRuntime(
  params: unknown,
): Promise<{ stopped: boolean }> {
  const runtimeId =
    params && typeof params === "object"
      ? Reflect.get(params, "runtimeId")
      : null;
  if (typeof runtimeId !== "string" || !runtimeId.trim()) {
    throw new Error("runtimeId is required");
  }
  const child = tunnels.get(runtimeId.trim());
  if (!child) return { stopped: false };
  tunnels.delete(runtimeId.trim());
  return { stopped: child.kill("SIGTERM") };
}
