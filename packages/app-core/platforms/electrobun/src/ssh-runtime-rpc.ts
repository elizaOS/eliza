/** Native SSH-agent tunnel lifecycle for Advanced remote runtime enrollment. */
import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { createNodePlatformSecureStore } from "@elizaos/app-core/security/platform-secure-store-node";
import { loadRemoteRuntimeAccessToken } from "@elizaos/app-core/security/remote-device-identity";

interface SshRuntimeParams {
  runtimeId: string;
  target: string;
  sshPort: number;
  remoteApiPort: number;
  identityFile?: string;
  credentialRef?: string;
}

interface SshTunnel {
  child: ChildProcess;
  localPort: number;
  fingerprint: string;
  credentialRef: string | null;
}

const tunnels = new Map<string, SshTunnel>();
const TARGET_PATTERN = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/;

function tunnelFingerprint(input: SshRuntimeParams): string {
  return JSON.stringify([
    input.target,
    input.sshPort,
    input.remoteApiPort,
    input.identityFile ?? null,
    input.credentialRef ?? null,
  ]);
}

function parseParams(params: unknown): SshRuntimeParams {
  if (!params || typeof params !== "object") {
    throw new Error("SSH runtime params must be an object");
  }
  const runtimeId = Reflect.get(params, "runtimeId");
  const target = Reflect.get(params, "target");
  const sshPort = Reflect.get(params, "sshPort");
  const remoteApiPort = Reflect.get(params, "remoteApiPort");
  const identityFile = Reflect.get(params, "identityFile");
  const credentialRef = Reflect.get(params, "credentialRef");
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
        identityFile.length > 4096)) ||
    (credentialRef !== undefined &&
      (typeof credentialRef !== "string" ||
        !credentialRef.trim() ||
        credentialRef.length > 256))
  ) {
    throw new Error("SSH runtime fields are invalid");
  }
  return {
    runtimeId: runtimeId.trim(),
    target,
    sshPort,
    remoteApiPort,
    ...(identityFile ? { identityFile } : {}),
    ...(typeof credentialRef === "string"
      ? { credentialRef: credentialRef.trim() }
      : {}),
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
  const fingerprint = tunnelFingerprint(input);
  if (prior?.child.exitCode === null && prior.fingerprint === fingerprint) {
    return {
      apiBase: `http://127.0.0.1:${prior.localPort}`,
      localPort: prior.localPort,
    };
  }
  if (prior?.child.exitCode === null) prior.child.kill("SIGTERM");
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
  const tunnel = {
    child,
    localPort,
    fingerprint,
    credentialRef: input.credentialRef ?? null,
  };
  tunnels.set(input.runtimeId, tunnel);
  child.once("exit", () => {
    if (tunnels.get(input.runtimeId) === tunnel)
      tunnels.delete(input.runtimeId);
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
  const tunnel = tunnels.get(runtimeId.trim());
  if (!tunnel) return { stopped: false };
  tunnels.delete(runtimeId.trim());
  return { stopped: tunnel.child.kill("SIGTERM") };
}

interface SshRuntimeRequest {
  runtimeId: string;
  credentialRef?: string;
  path: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}

const ALLOWED_AGENT_PATHS = [
  /^\/api\/health$/,
  /^\/api\/agents$/,
  /^\/api\/conversations$/,
  /^\/api\/conversations\/messages\/search$/,
  /^\/api\/conversations\/[^/]+$/,
  /^\/api\/conversations\/[^/]+\/messages$/,
  /^\/api\/conversations\/[^/]+\/messages\/stream$/,
  /^\/api\/conversations\/[^/]+\/greeting$/,
  /^\/api\/turns\/[^/]+\/abort$/,
  /^\/api\/agent\/(pause|resume|stop)$/,
];

export function normalizeSshRuntimeRequest(params: unknown): SshRuntimeRequest {
  if (!params || typeof params !== "object")
    throw new Error("SSH runtime request params must be an object");
  const record = params as Record<string, unknown>;
  const runtimeId = record.runtimeId;
  const credentialRef = record.credentialRef;
  const path = record.path;
  const method = record.method;
  const body = record.body;
  const timeoutMs = record.timeoutMs;
  if (
    typeof runtimeId !== "string" ||
    !runtimeId.trim() ||
    runtimeId.length > 256 ||
    (credentialRef !== undefined &&
      (typeof credentialRef !== "string" ||
        !credentialRef.trim() ||
        credentialRef.length > 256)) ||
    typeof path !== "string" ||
    path.length > 2_048 ||
    typeof method !== "string" ||
    !["GET", "POST", "PATCH", "DELETE"].includes(method) ||
    (body !== null && (typeof body !== "string" || body.length > 1_000_000)) ||
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10 * 60_000
  ) {
    throw new Error("SSH runtime request fields are invalid");
  }
  const parsedPath = new URL(path, "http://eliza.ssh");
  if (
    parsedPath.origin !== "http://eliza.ssh" ||
    !ALLOWED_AGENT_PATHS.some((pattern) => pattern.test(parsedPath.pathname))
  ) {
    throw new Error("SSH runtime request route is not allowed");
  }
  const headers =
    record.headers && typeof record.headers === "object"
      ? Object.fromEntries(
          Object.entries(record.headers as Record<string, unknown>)
            .filter(
              ([key, value]) =>
                ["accept", "content-type"].includes(key.toLowerCase()) &&
                typeof value === "string" &&
                value.length <= 256,
            )
            .map(([key, value]) => [key, value as string]),
        )
      : {};
  return {
    runtimeId: runtimeId.trim(),
    ...(typeof credentialRef === "string"
      ? { credentialRef: credentialRef.trim() }
      : {}),
    path: `${parsedPath.pathname}${parsedPath.search}`,
    method: method as SshRuntimeRequest["method"],
    headers,
    body: body as string | null,
    timeoutMs,
  };
}

export async function desktopSshRuntimeRequest(params: unknown): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}> {
  const request = normalizeSshRuntimeRequest(params);
  const tunnel = tunnels.get(request.runtimeId);
  if (!tunnel || tunnel.child.exitCode !== null) {
    throw new Error("SSH runtime tunnel is not running");
  }
  if ((request.credentialRef ?? null) !== tunnel.credentialRef) {
    throw new Error("SSH runtime credential is not bound to this tunnel");
  }
  const token = request.credentialRef
    ? await loadRemoteRuntimeAccessToken(
        createNodePlatformSecureStore(),
        request.credentialRef,
      )
    : null;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), request.timeoutMs);
  try {
    const response = await fetch(
      `http://127.0.0.1:${tunnel.localPort}${request.path}`,
      {
        method: request.method,
        headers: {
          ...request.headers,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: request.body,
        signal: abortController.signal,
      },
    );
    const headers: Record<string, string> = {};
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.length <= 256) {
      headers["content-type"] = contentType;
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > 4 * 1024 * 1024) {
      await response.body?.cancel();
      throw new Error("SSH runtime response exceeds the 4 MiB limit");
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        total += item.value.byteLength;
        if (total > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("SSH runtime response exceeds the 4 MiB limit");
        }
        chunks.push(item.value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let responseBody: string;
    try {
      responseBody = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("SSH runtime response is not valid UTF-8");
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body: responseBody,
    };
  } finally {
    clearTimeout(timeout);
  }
}
