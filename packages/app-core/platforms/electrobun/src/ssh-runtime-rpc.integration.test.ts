/**
 * Real macOS SSH acceptance for the native runtime gateway.
 *
 * The test launches the system sshd and ssh binaries with throwaway keys,
 * forwards to a disposable loopback HTTP agent, and exercises the production
 * RPC functions. Credential calls are backed by an in-memory Vitest stub so
 * this proof never reads or writes the developer's Keychain or SSH directory.
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const storedFingerprints = vi.hoisted(() => new Map<string, string>());

vi.mock("./runtime-credential-rpc", () => ({
  desktopLoadRuntimeCredential: async () => ({ accessToken: null }),
  readRuntimeCredentialSnapshot: async (runtimeId: string) => ({
    accessToken: null,
    sshHostFingerprint: storedFingerprints.get(runtimeId) ?? null,
  }),
  storeSshHostFingerprint: async (runtimeId: string, fingerprint: string) => {
    storedFingerprints.set(runtimeId, fingerprint);
  },
}));

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

describeMacOS("SSH runtime RPC disposable tunnel", () => {
  const runtimeId = `ssh-live-${process.pid}-${Date.now()}`;
  const requests: Array<{
    method: string;
    url: string;
    authorization: string | null;
  }> = [];
  let tempRoot = "";
  let priorHome: string | undefined;
  let sshd: ChildProcess | null = null;
  let sshdStderr = "";
  let sshPort = 0;
  let apiPort = 0;
  let identityFile = "";
  let authorizedKeys = "";
  let sshdConfig = "";
  let hostKey = "";
  let hostKeyFingerprint = "";
  let apiServer: Server | null = null;

  const stopSshd = async () => {
    const running = sshd;
    if (!running || running.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      running.once("exit", () => resolve());
      running.kill("SIGTERM");
    });
  };

  const startSshd = async (keyPath: string) => {
    await writeFile(
      sshdConfig,
      [
        `Port ${sshPort}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${keyPath}`,
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
    sshdStderr = "";
    sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", sshdConfig], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    sshd.stderr?.setEncoding("utf8");
    sshd.stderr?.on("data", (chunk: string) => {
      sshdStderr = `${sshdStderr}${chunk}`.slice(-8_000);
    });
    await waitForPort(sshPort, sshd, () => sshdStderr);
  };

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "eliza-ssh-gateway-"));
    const home = path.join(tempRoot, "home");
    await mkdir(path.join(home, ".ssh"), { recursive: true, mode: 0o700 });
    priorHome = process.env.HOME;
    process.env.HOME = home;

    hostKey = path.join(tempRoot, "ssh_host_ed25519_key");
    identityFile = path.join(tempRoot, "controller_ed25519");
    for (const keyPath of [hostKey, identityFile]) {
      execFileSync("/usr/bin/ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        keyPath,
      ]);
      await chmod(keyPath, 0o600);
    }
    hostKeyFingerprint = execFileSync(
      "/usr/bin/ssh-keygen",
      ["-lf", `${hostKey}.pub`, "-E", "sha256"],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\s+/)[1];
    authorizedKeys = path.join(tempRoot, "authorized_keys");
    await writeFile(authorizedKeys, await readFile(`${identityFile}.pub`));
    await chmod(authorizedKeys, 0o600);

    apiServer = createServer((request, response) => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization ?? null,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, source: "disposable-vps" }));
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
    sshdConfig = path.join(tempRoot, "sshd_config");
    await startSshd(hostKey);
  }, 30_000);

  afterAll(async () => {
    await desktopStopSshRuntime({ runtimeId });
    await new Promise<void>((resolve) => {
      if (!apiServer) return resolve();
      apiServer.close(() => resolve());
    });
    await stopSshd();
    storedFingerprints.delete(runtimeId);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("forwards safely, recovers after outage, and rejects a changed host key", async () => {
    const input = {
      runtimeId,
      target: `${os.userInfo().username}@127.0.0.1`,
      sshPort,
      remoteApiPort: apiPort,
      expectedFingerprint: hostKeyFingerprint,
      identityFile,
    };
    const first = await desktopStartSshRuntime(input);
    await expect(desktopStartSshRuntime(input)).resolves.toEqual(first);

    await expect(
      desktopSshRuntimeRequest({
        runtimeId,
        path: "/api/health?probe=ssh",
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "renderer-token-must-not-forward",
          "x-forwarded-host": "attacker.example",
        },
        body: null,
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(requests.at(-1)).toEqual({
      method: "GET",
      url: "/api/health?probe=ssh",
      authorization: null,
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
    ).rejects.toThrow("not available through SSH");

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
    ).rejects.toThrow("tunnel is offline");
    await stopSshd();
    await expect(desktopStartSshRuntime(input)).rejects.toThrow(
      /no SSH host key was received|host key verification failed|SSH tunnel failed|exited before|timed out/i,
    );
    await startSshd(hostKey);
    await expect(desktopStartSshRuntime(input)).resolves.toMatchObject({
      fingerprint: hostKeyFingerprint,
    });

    await desktopStopSshRuntime({ runtimeId });
    await stopSshd();
    const replacementHostKey = path.join(tempRoot, "replacement_host_key");
    execFileSync("/usr/bin/ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      replacementHostKey,
    ]);
    await chmod(replacementHostKey, 0o600);
    await startSshd(replacementHostKey);
    await expect(desktopStartSshRuntime(input)).rejects.toThrow(
      /host key changed|fingerprint/i,
    );
  }, 45_000);
});
