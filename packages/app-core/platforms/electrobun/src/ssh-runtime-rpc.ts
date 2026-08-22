/**
 * Owns Advanced SSH enrollment and the loopback-only agent tunnel. Host keys
 * are scanned and shown before use, pinned as SHA256 fingerprints in the OS
 * credential store, and enforced through a private strict known-hosts file.
 * Authentication uses the user's SSH agent or an explicit key path in place;
 * private key material is never read, copied, or returned to the renderer.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  desktopLoadRuntimeCredential,
  readRuntimeCredentialSnapshot,
  storeSshHostFingerprint,
} from "./runtime-credential-rpc";

const SSH_TARGET_PATTERN = /^([A-Za-z0-9._-]{1,64})@([A-Za-z0-9.-]{1,253})$/;
const MAX_DIAGNOSTIC_STDERR_CHARS = 8_192;
const MAX_KEYSCAN_OUTPUT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ALLOWED_AGENT_PATHS = [
  /^\/api\/health$/,
  /^\/api\/status$/,
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

export interface SshHostFingerprint {
  algorithm: string;
  fingerprint: string;
}

export interface SshHostInspection {
  target: string;
  host: string;
  sshPort: number;
  fingerprints: SshHostFingerprint[];
  preferredFingerprint: string;
  pinnedFingerprint: string | null;
  changed: boolean;
}

interface ParsedSshRuntimeParams {
  runtimeId: string;
  target: string;
  user: string;
  host: string;
  sshPort: number;
  remoteApiPort: number;
  identityFile?: string;
  credentialRef?: string;
  expectedFingerprint: string;
}

interface SshTunnel {
  child: ChildProcess;
  localPort: number;
  signature: string;
  credentialRef: string | null;
  tempDir: string;
  startedAt: number;
  disposePromise?: Promise<void>;
}

const tunnels = new Map<string, SshTunnel>();

function requirePort(value: unknown, field: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 65_535
  ) {
    throw new Error(`${field} must be between 1 and 65535.`);
  }
  return value as number;
}

function parseTarget(value: unknown): {
  target: string;
  user: string;
  host: string;
} {
  if (typeof value !== "string") throw new Error("SSH target is required.");
  const target = value.trim();
  const match = SSH_TARGET_PATTERN.exec(target);
  const user = match?.[1];
  const host = match?.[2];
  if (!user || !host) throw new Error("SSH target must look like user@host.");
  return { target, user, host: host.toLowerCase() };
}

function requireRuntimeId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(value.trim())
  ) {
    throw new Error("Runtime id is invalid.");
  }
  return value.trim();
}

function requireFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value)) {
    throw new Error("Confirm a valid SHA256 SSH host fingerprint first.");
  }
  return value;
}

function parseStartParams(params: unknown): ParsedSshRuntimeParams {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("SSH runtime parameters are required.");
  }
  const runtimeId = requireRuntimeId(Reflect.get(params, "runtimeId"));
  const target = parseTarget(Reflect.get(params, "target"));
  const sshPort = requirePort(Reflect.get(params, "sshPort"), "SSH port");
  const remoteApiPort = requirePort(
    Reflect.get(params, "remoteApiPort"),
    "Remote API port",
  );
  const identityFile = Reflect.get(params, "identityFile");
  if (
    identityFile !== undefined &&
    (typeof identityFile !== "string" ||
      !path.isAbsolute(identityFile) ||
      identityFile.length > 4_096 ||
      /[\r\n\0]/.test(identityFile))
  ) {
    throw new Error("SSH identity file must be an absolute local path.");
  }
  const credentialRef = Reflect.get(params, "credentialRef");
  if (
    credentialRef !== undefined &&
    (typeof credentialRef !== "string" ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(credentialRef.trim()))
  ) {
    throw new Error("SSH credential reference is invalid.");
  }
  if (typeof credentialRef === "string" && credentialRef.trim() !== runtimeId) {
    throw new Error("SSH credentials must belong to the selected runtime.");
  }
  return {
    runtimeId,
    ...target,
    sshPort,
    remoteApiPort,
    expectedFingerprint: requireFingerprint(
      Reflect.get(params, "expectedFingerprint"),
    ),
    ...(typeof identityFile === "string" ? { identityFile } : {}),
    ...(typeof credentialRef === "string"
      ? { credentialRef: credentialRef.trim() }
      : {}),
  };
}

export function parseSshKeyscanOutput(
  output: string,
): Array<SshHostFingerprint & { knownHostLine: string }> {
  const seen = new Set<string>();
  const results: Array<SshHostFingerprint & { knownHostLine: string }> = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 3) continue;
    const algorithm = fields[1];
    const publicKey = fields[2];
    if (!algorithm || !publicKey) continue;
    if (
      !/^ssh-(ed25519|rsa)$/.test(algorithm) &&
      !/^ecdsa-sha2-nistp(256|384|521)$/.test(algorithm)
    ) {
      continue;
    }
    let keyBytes: Buffer;
    try {
      keyBytes = Buffer.from(publicKey, "base64");
      if (
        keyBytes.length === 0 ||
        keyBytes.toString("base64").replace(/=+$/, "") !==
          publicKey.replace(/=+$/, "")
      ) {
        continue;
      }
    } catch {
      // error-policy:J3 ssh-keyscan output is untrusted subprocess data.
      continue;
    }
    const fingerprint = `SHA256:${createHash("sha256")
      .update(keyBytes)
      .digest("base64")
      .replace(/=+$/, "")}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    results.push({ algorithm, fingerprint, knownHostLine: line });
  }
  const rank = (algorithm: string): number => {
    if (algorithm === "ssh-ed25519") return 0;
    if (algorithm === "ecdsa-sha2-nistp256") return 1;
    if (algorithm.startsWith("ecdsa-")) return 2;
    return 3;
  };
  return results.sort((a, b) => rank(a.algorithm) - rank(b.algorithm));
}

function keyscanCommand(): string {
  if (process.platform !== "win32") return "/usr/bin/ssh-keyscan";
  const systemRoot = process.env.SystemRoot;
  if (
    !systemRoot ||
    !/^[A-Za-z]:\\Windows$/i.test(systemRoot) ||
    /[\r\n\0]/.test(systemRoot)
  ) {
    throw new Error("The Windows OpenSSH installation path is unavailable.");
  }
  return path.win32.join(systemRoot, "System32", "OpenSSH", "ssh-keyscan.exe");
}

function scanSshHost(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      keyscanCommand(),
      ["-T", "8", "-p", String(port), "--", host],
      {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stdoutBytes = 0;
    let diagnosticStderrTail = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(error);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > MAX_KEYSCAN_OUTPUT_BYTES) {
        fail(new Error("The SSH host returned too much host-key data."));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      diagnosticStderrTail = `${diagnosticStderrTail}${chunk}`.slice(
        -MAX_DIAGNOSTIC_STDERR_CHARS,
      );
    });
    child.once("error", (cause) => {
      fail(new Error("OpenSSH host-key scanning is unavailable.", { cause }));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout);
      else
        reject(
          new Error(
            diagnosticStderrTail.toLowerCase().includes("resolve hostname")
              ? "The SSH host name could not be resolved."
              : "No SSH host key was received. Check the host and port.",
          ),
        );
    });
  });
}

export async function desktopInspectSshHost(
  params: unknown,
): Promise<SshHostInspection> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("SSH inspection parameters are required.");
  }
  const runtimeId = requireRuntimeId(Reflect.get(params, "runtimeId"));
  const { target, host } = parseTarget(Reflect.get(params, "target"));
  const sshPort = requirePort(Reflect.get(params, "sshPort"), "SSH port");
  const keys = parseSshKeyscanOutput(await scanSshHost(host, sshPort));
  if (keys.length === 0) {
    throw new Error("The SSH host returned no supported public host key.");
  }
  const { sshHostFingerprint: pinnedFingerprint } =
    await readRuntimeCredentialSnapshot(runtimeId);
  const preferredKey =
    keys.find((key) => key.fingerprint === pinnedFingerprint) ?? keys[0];
  if (!preferredKey)
    throw new Error("The SSH host did not present a supported key.");
  return {
    target,
    host,
    sshPort,
    fingerprints: keys.map(({ algorithm, fingerprint }) => ({
      algorithm,
      fingerprint,
    })),
    preferredFingerprint: preferredKey.fingerprint,
    pinnedFingerprint,
    changed:
      pinnedFingerprint !== null &&
      !keys.some((key) => key.fingerprint === pinnedFingerprint),
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
          reject(error ?? new Error("No local port is available."));
        else resolve(port);
      });
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(250);
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function waitForTunnel(
  child: ChildProcess,
  localPort: number,
  readSpawnError: () => Error | null,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const error = readSpawnError();
    if (error) throw error;
    if (child.exitCode !== null) {
      throw new Error("SSH exited before the private tunnel was ready.");
    }
    if (await canConnect(localPort)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("SSH authentication or tunnel setup timed out.");
}

function sshFailure(diagnosticStderrTail: string, fallback: unknown): Error {
  const normalized = diagnosticStderrTail.toLowerCase();
  if (normalized.includes("host key verification failed")) {
    return new Error(
      "SSH host-key verification failed. Inspect the fingerprint again.",
    );
  }
  if (normalized.includes("permission denied")) {
    return new Error(
      "SSH authentication failed. Add the key to your SSH agent or choose the correct identity file.",
    );
  }
  if (normalized.includes("connection refused")) {
    return new Error(
      "The SSH host refused the connection. Check the host and port.",
    );
  }
  if (normalized.includes("timed out")) {
    return new Error(
      "The SSH connection timed out. Check network access and firewall rules.",
    );
  }
  return fallback instanceof Error
    ? new Error(fallback.message)
    : new Error("The SSH tunnel could not be started.");
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function disposeTunnel(
  tunnel: SshTunnel,
  shutdownTimeoutMs = 2_000,
): Promise<void> {
  if (tunnel.disposePromise) return tunnel.disposePromise;
  tunnel.disposePromise = (async () => {
    if (tunnel.child.exitCode === null && tunnel.child.signalCode === null) {
      tunnel.child.kill("SIGTERM");
      if (!(await waitForChildExit(tunnel.child, shutdownTimeoutMs))) {
        tunnel.child.kill("SIGKILL");
        if (!(await waitForChildExit(tunnel.child, shutdownTimeoutMs))) {
          throw new Error(
            "SSH tunnel process did not exit after forced shutdown.",
          );
        }
      }
    }
    // error-policy:J6 this directory contains only the strict known-hosts file
    // created for this tunnel; process teardown may already have removed it.
    await fs.rm(tunnel.tempDir, { recursive: true, force: true });
  })();
  return tunnel.disposePromise;
}

function tunnelSignature(input: ParsedSshRuntimeParams): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.target,
        input.sshPort,
        input.remoteApiPort,
        input.identityFile ?? null,
        input.credentialRef ?? null,
        input.expectedFingerprint,
      ]),
    )
    .digest("hex");
}

function sshExecutable(): string {
  if (process.platform === "win32") return "ssh.exe";
  return "/usr/bin/ssh";
}

export async function desktopStartSshRuntime(
  params: unknown,
): Promise<{ apiBase: string; localPort: number; fingerprint: string }> {
  const input = parseStartParams(params);
  const signature = tunnelSignature(input);
  const prior = tunnels.get(input.runtimeId);
  if (prior?.child.exitCode === null && prior.signature === signature) {
    return {
      apiBase: `http://127.0.0.1:${prior.localPort}`,
      localPort: prior.localPort,
      fingerprint: input.expectedFingerprint,
    };
  }

  const keys = parseSshKeyscanOutput(
    await scanSshHost(input.host, input.sshPort),
  );
  const selected = keys.find(
    (key) => key.fingerprint === input.expectedFingerprint,
  );
  if (!selected) {
    throw new Error(
      "SSH host key changed or the confirmed fingerprint is no longer offered. Connection was blocked.",
    );
  }
  const credential = await readRuntimeCredentialSnapshot(input.runtimeId);
  if (
    credential.sshHostFingerprint &&
    credential.sshHostFingerprint !== input.expectedFingerprint
  ) {
    throw new Error(
      "SSH host key changed from the previously trusted fingerprint. Connection was blocked.",
    );
  }
  if (!credential.sshHostFingerprint) {
    await storeSshHostFingerprint(input.runtimeId, input.expectedFingerprint);
  }

  if (prior) {
    tunnels.delete(input.runtimeId);
    await disposeTunnel(prior);
  }

  const localPort = await reserveLoopbackPort();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-ssh-"));
  await fs.chmod(tempDir, 0o700);
  const knownHostsPath = path.join(tempDir, `known-hosts-${randomUUID()}`);
  await fs.writeFile(knownHostsPath, `${selected.knownHostLine}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
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
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    `HostKeyAlgorithms=${selected.algorithm}`,
    "-o",
    "ConnectTimeout=8",
    ...(process.platform === "win32"
      ? []
      : ["-o", "GlobalKnownHostsFile=/dev/null"]),
    ...(input.identityFile
      ? ["-o", "IdentitiesOnly=yes", "-i", input.identityFile]
      : []),
    "--",
    input.target,
  ];
  const child = spawn(sshExecutable(), args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let spawnError: Error | null = null;
  let diagnosticStderrTail = "";
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    diagnosticStderrTail = `${diagnosticStderrTail}${chunk}`.slice(
      -MAX_DIAGNOSTIC_STDERR_CHARS,
    );
  });
  try {
    await waitForTunnel(child, localPort, () => spawnError);
  } catch (error) {
    // error-policy:J1 the native RPC boundary tears down partial state and
    // returns a stable SSH failure without exposing subprocess diagnostics.
    await disposeTunnel({
      child,
      localPort,
      signature,
      credentialRef: input.credentialRef ?? null,
      tempDir,
      startedAt: Date.now(),
    });
    throw sshFailure(diagnosticStderrTail, error);
  }
  const tunnel: SshTunnel = {
    child,
    localPort,
    signature,
    credentialRef: input.credentialRef ?? null,
    tempDir,
    startedAt: Date.now(),
  };
  tunnels.set(input.runtimeId, tunnel);
  child.once("exit", () => {
    if (tunnels.get(input.runtimeId) === tunnel) {
      tunnels.delete(input.runtimeId);
    }
    void disposeTunnel(tunnel);
  });
  return {
    apiBase: `http://127.0.0.1:${localPort}`,
    localPort,
    fingerprint: input.expectedFingerprint,
  };
}

export async function desktopStopSshRuntime(
  params: unknown,
): Promise<{ stopped: boolean }> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("SSH runtime parameters are required.");
  }
  const runtimeId = requireRuntimeId(Reflect.get(params, "runtimeId"));
  const tunnel = tunnels.get(runtimeId);
  if (!tunnel) return { stopped: false };
  tunnels.delete(runtimeId);
  await disposeTunnel(tunnel);
  return { stopped: true };
}

export async function desktopGetSshRuntimeStatus(params: unknown): Promise<{
  running: boolean;
  localPort: number | null;
  startedAt: number | null;
}> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("SSH runtime parameters are required.");
  }
  const runtimeId = requireRuntimeId(Reflect.get(params, "runtimeId"));
  const tunnel = tunnels.get(runtimeId);
  const running = tunnel?.child.exitCode === null;
  return {
    running,
    localPort: running ? tunnel.localPort : null,
    startedAt: running ? tunnel.startedAt : null,
  };
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

export function normalizeSshRuntimeRequest(params: unknown): SshRuntimeRequest {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("SSH request parameters are required.");
  }
  const record = params as Record<string, unknown>;
  const runtimeId = requireRuntimeId(record.runtimeId);
  const credentialRef = record.credentialRef;
  if (
    credentialRef !== undefined &&
    (typeof credentialRef !== "string" ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(credentialRef.trim()))
  ) {
    throw new Error("SSH credential reference is invalid.");
  }
  if (typeof credentialRef === "string" && credentialRef.trim() !== runtimeId) {
    throw new Error("SSH credentials must belong to the selected runtime.");
  }
  if (
    typeof record.path !== "string" ||
    record.path.length > 2_048 ||
    typeof record.method !== "string" ||
    !["GET", "POST", "PATCH", "DELETE"].includes(record.method) ||
    (record.body !== null &&
      (typeof record.body !== "string" || record.body.length > 1_000_000)) ||
    typeof record.timeoutMs !== "number" ||
    !Number.isFinite(record.timeoutMs) ||
    record.timeoutMs < 1 ||
    record.timeoutMs > 10 * 60_000
  ) {
    throw new Error("SSH request fields are invalid.");
  }
  const parsedPath = new URL(record.path, "http://eliza.ssh");
  if (
    parsedPath.origin !== "http://eliza.ssh" ||
    !ALLOWED_AGENT_PATHS.some((pattern) => pattern.test(parsedPath.pathname))
  ) {
    throw new Error("That agent route is not available through SSH.");
  }
  const headers =
    record.headers && typeof record.headers === "object"
      ? Object.fromEntries(
          Object.entries(record.headers as Record<string, unknown>)
            .filter(
              ([key, value]) =>
                ["accept", "content-type"].includes(key.toLowerCase()) &&
                typeof value === "string" &&
                value.length <= 256 &&
                !/[\r\n\0]/.test(value),
            )
            .map(([key, value]) => [key.toLowerCase(), value as string]),
        )
      : {};
  return {
    runtimeId,
    ...(typeof credentialRef === "string"
      ? { credentialRef: credentialRef.trim() }
      : {}),
    path: `${parsedPath.pathname}${parsedPath.search}`,
    method: record.method as SshRuntimeRequest["method"],
    headers,
    body: record.body as string | null,
    timeoutMs: record.timeoutMs,
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
    throw new Error("The SSH tunnel is offline. Reconnect and try again.");
  }
  if ((request.credentialRef ?? null) !== tunnel.credentialRef) {
    throw new Error("The runtime credential is not bound to this SSH tunnel.");
  }
  const credential = await desktopLoadRuntimeCredential({
    runtimeId: request.runtimeId,
  });
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), request.timeoutMs);
  try {
    const response = await fetch(
      `http://127.0.0.1:${tunnel.localPort}${request.path}`,
      {
        method: request.method,
        headers: {
          ...request.headers,
          ...(credential.accessToken
            ? { authorization: `Bearer ${credential.accessToken}` }
            : {}),
        },
        body: request.body,
        redirect: "error",
        signal: abortController.signal,
      },
    );
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_RESPONSE_BYTES
    ) {
      await response.body?.cancel();
      throw new Error("The SSH runtime response exceeded the 4 MiB limit.");
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        total += item.value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("The SSH runtime response exceeded the 4 MiB limit.");
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
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // error-policy:J1 the native transport rejects unsupported binary data.
      throw new Error("The SSH runtime returned a non-text response.");
    }
    const headers: Record<string, string> = {};
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.length <= 256) {
      headers["content-type"] = contentType;
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
    };
  } catch (error) {
    // error-policy:J1 the renderer/main transport boundary exposes a stable,
    // actionable failure without leaking native request details.
    if (abortController.signal.aborted) {
      throw new Error("The SSH runtime request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const sshRuntimeInternals = {
  disposeTunnel,
  waitForChildExit,
  parseStartParams,
  parseTarget,
  requireFingerprint,
  requireRuntimeId,
  tunnelSignature,
};
