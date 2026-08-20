/**
 * Real macOS SSH acceptance test for the native runtime gateway.
 *
 * Unlike the boundary unit tests, this launches the system sshd and ssh
 * binaries with throwaway keys, forwards to a loopback HTTP agent, and uses the
 * production native RPC functions end to end. All SSH state lives under a
 * temporary HOME. It deliberately does not touch the developer's login
 * Keychain; secure-store credential persistence is covered by its isolated
 * backend tests and the signed native-app lane.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  desktopSshRuntimeRequest,
  desktopStartSshRuntime,
  desktopStopSshRuntime,
} from "./ssh-runtime-rpc";

const describeMacOS = process.platform === "darwin" ? describe : describe.skip;

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForPort(
  port: number,
  child: ChildProcess,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`sshd exited early: ${stderr()}`);
    }
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(200);
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
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`sshd did not listen in time: ${stderr()}`);
}

describeMacOS("SSH runtime RPC real tunnel", () => {
  const runtimeId = `ssh-live-${process.pid}-${Date.now()}`;
  const requests: Array<{
    method: string;
    url: string;
    authorization: string | null;
    body: string;
  }> = [];
  let tempRoot = "";
  let priorHome: string | undefined;
  let sshd: ChildProcess | null = null;
  let sshdStderr = "";
  let sshPort = 0;
  let apiPort = 0;
  let identityFile = "";
  let apiServer: Server | null = null;

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "eliza-ssh-gateway-"));
    const home = path.join(tempRoot, "home");
    await mkdir(path.join(home, ".ssh"), { recursive: true, mode: 0o700 });
    priorHome = process.env.HOME;
    process.env.HOME = home;

    const hostKey = path.join(tempRoot, "ssh_host_ed25519_key");
    identityFile = path.join(tempRoot, "controller_ed25519");
    execFileSync("/usr/bin/ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      hostKey,
    ]);
    execFileSync("/usr/bin/ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      identityFile,
    ]);
    await chmod(hostKey, 0o600);
    await chmod(identityFile, 0o600);
    const authorizedKeys = path.join(tempRoot, "authorized_keys");
    await writeFile(authorizedKeys, await readFile(`${identityFile}.pub`));
    await chmod(authorizedKeys, 0o600);

    apiServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          authorization: request.headers.authorization ?? null,
          body,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            source: "disposable-vps",
            method: request.method,
            url: request.url,
            body,
          }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      apiServer?.once("error", reject);
      apiServer?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Disposable VPS API did not bind to TCP");
    }
    apiPort = address.port;

    sshPort = await reserveLoopbackPort();
    const config = path.join(tempRoot, "sshd_config");
    await writeFile(
      config,
      [
        `Port ${sshPort}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKey}`,
        `PidFile ${path.join(tempRoot, "sshd.pid")}`,
        `AuthorizedKeysFile ${authorizedKeys}`,
        `AllowUsers ${os.userInfo().username}`,
        "PubkeyAuthentication yes",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "ChallengeResponseAuthentication no",
        "UsePAM no",
        "StrictModes no",
        "AllowTcpForwarding local",
        "PermitTTY no",
        "X11Forwarding no",
        "UseDNS no",
        "LogLevel VERBOSE",
        "",
      ].join("\n"),
    );
    sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    sshd.stderr?.setEncoding("utf8");
    sshd.stderr?.on("data", (chunk: string) => {
      sshdStderr = `${sshdStderr}${chunk}`.slice(-8_000);
    });
    await waitForPort(sshPort, sshd, () => sshdStderr);
  }, 30_000);

  afterAll(async () => {
    await desktopStopSshRuntime({ runtimeId }).catch(() => {});
    await new Promise<void>((resolve) => {
      if (!apiServer) return resolve();
      apiServer.close(() => resolve());
    });
    if (sshd?.exitCode === null) sshd.kill("SIGTERM");
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("forwards allowlisted agent traffic without leaking controller authorization", async () => {
    const input = {
      runtimeId,
      target: `${os.userInfo().username}@127.0.0.1`,
      sshPort,
      remoteApiPort: apiPort,
      identityFile,
    };
    const first = await desktopStartSshRuntime(input);
    const second = await desktopStartSshRuntime(input);
    expect(second).toEqual(first);

    const result = await desktopSshRuntimeRequest({
      runtimeId,
      path: "/api/health?probe=ssh",
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "attacker-token",
        "x-forwarded-host": "evil.example",
      },
      body: null,
      timeoutMs: 5_000,
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: true,
      source: "disposable-vps",
      url: "/api/health?probe=ssh",
    });
    expect(requests.at(-1)).toMatchObject({
      method: "GET",
      url: "/api/health?probe=ssh",
      authorization: null,
    });
  });

  it("preserves an allowed POST body and blocks non-agent routes", async () => {
    const result = await desktopSshRuntimeRequest({
      runtimeId,
      path: "/api/conversations/room-1/messages",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello through ssh" }),
      timeoutMs: 5_000,
    });
    expect(result.status).toBe(200);
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/conversations/room-1/messages",
      authorization: null,
      body: JSON.stringify({ text: "hello through ssh" }),
    });
    await expect(
      desktopSshRuntimeRequest({
        runtimeId,
        path: "/api/settings",
        method: "GET",
        headers: {},
        body: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("route is not allowed");
  });

  it("stops cleanly and can restore the tunnel after a simulated restart", async () => {
    await expect(desktopStopSshRuntime({ runtimeId })).resolves.toEqual({
      stopped: true,
    });
    await expect(
      desktopSshRuntimeRequest({
        runtimeId,
        path: "/api/health",
        method: "GET",
        headers: {},
        body: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("tunnel is not running");

    await desktopStartSshRuntime({
      runtimeId,
      target: `${os.userInfo().username}@127.0.0.1`,
      sshPort,
      remoteApiPort: apiPort,
      identityFile,
    });
    await expect(
      desktopSshRuntimeRequest({
        runtimeId,
        path: "/api/health",
        method: "GET",
        headers: {},
        body: null,
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ status: 200 });
  });
});
