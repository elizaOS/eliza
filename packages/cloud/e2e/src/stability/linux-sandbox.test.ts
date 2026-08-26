/**
 * Proves the Linux stability sandbox rejects credential, process, descriptor,
 * and kernel-network escapes while preserving declared mock-proxy access.
 */

import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loopbackPorts,
  sandboxCommand,
  scenarioChildEnvironment,
} from "./linux-sandbox.ts";

test("credential-minimal child environment rejects ambient runner secrets", () => {
  const environment = scenarioChildEnvironment(
    {
      PATH: "/bin",
      GITHUB_TOKEN: "runner-token",
      OPENAI_API_KEY: "provider-key",
      DATABASE_PASSWORD: "database-secret",
      SAFE_SETTING: "retained",
    },
    { OPENAI_API_KEY: "sandbox-proxy-credential" },
  );
  expect(environment).toEqual({
    PATH: "/bin",
    SAFE_SETTING: "retained",
    OPENAI_API_KEY: "sandbox-proxy-credential",
  });
});

test("loopback allowlist rejects non-loopback and implicit ports", () => {
  expect(
    loopbackPorts(["http://127.0.0.1:4312", "http://127.0.0.1:4311"]),
  ).toBe("4311,4312");
  expect(() => loopbackPorts(["https://api.openai.com:443"])).toThrow(
    "not IPv4 loopback",
  );
  expect(() => loopbackPorts(["http://127.0.0.1"])).toThrow(
    "no explicit valid port",
  );
});

test("sandbox launch has no unprivileged fallback when sudo is absent", async () => {
  const launch = sandboxCommand({
    uid: "65534",
    allowedPorts: "4311",
    repoRoot: "/repo",
    outputDir: "/output",
    runtime: "/runtime",
    args: [],
  });
  const child = spawn(launch.command, launch.args, {
    env: { PATH: "/definitely-no-sudo" },
    stdio: "ignore",
  });
  const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
    child.once("error", resolve);
  });
  expect(error.code).toBe("ENOENT");
});

const sandboxUid = process.env.ELIZA_STABILITY_LINUX_SANDBOX_UID;
const hostedLinux = process.platform === "linux" && sandboxUid !== undefined;

test.skipIf(!hostedLinux)(
  "kernel boundary blocks proc, fd, TCP, UDP, and DNS escapes",
  async () => {
    if (!sandboxUid) throw new Error("sandbox UID unavailable");
    const directory = await mkdtemp(
      path.join(tmpdir(), "cloud-sandbox-proof-"),
    );
    const allowed = createServer((socket) => socket.end("allowed"));
    const blocked = createServer((socket) => socket.end("blocked"));
    const blockedIpv6 = createServer((socket) => socket.end("blocked-ipv6"));
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        allowed.once("error", reject);
        allowed.listen(0, "127.0.0.1", resolve);
      }),
      new Promise<void>((resolve, reject) => {
        blocked.once("error", reject);
        blocked.listen(0, "127.0.0.1", resolve);
      }),
      new Promise<void>((resolve, reject) => {
        blockedIpv6.once("error", reject);
        blockedIpv6.listen(0, "::1", resolve);
      }),
    ]);
    try {
      const allowedPort = (allowed.address() as { port: number }).port;
      const blockedPort = (blocked.address() as { port: number }).port;
      const blockedIpv6Port = (blockedIpv6.address() as { port: number }).port;
      const probe = path.join(directory, "probe.ts");
      await writeFile(
        probe,
        `
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { createSocket } from "node:dgram";
const tcp = (host, port) => new Promise((resolve) => {
  const socket = connect({ host, port });
  const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1500);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
  socket.once("error", () => { clearTimeout(timer); resolve(false); });
});
const udp = (family, host, port) => new Promise((resolve) => {
  const socket = createSocket(family);
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    socket.close();
    resolve(value);
  };
  const timer = setTimeout(() => finish(true), 750);
  socket.once("error", () => { clearTimeout(timer); finish(false); });
  socket.connect(port, host, () => {
    socket.send(Buffer.from("escape"), (error) => {
      if (error) { clearTimeout(timer); finish(false); }
    });
  });
});
let procReadable = false;
try { readFileSync("/proc/" + process.env.PROBE_PARENT_PID + "/environ"); procReadable = true; } catch {}
let fdSecretReadable = false;
try { fdSecretReadable = readFileSync(3, "utf8").includes("fd-secret"); } catch {}
const rawProbeAvailable = spawnSync("python3", ["--version"]).status === 0;
console.log(JSON.stringify({
  secretPresent: process.env.PROBE_PARENT_CREDENTIAL !== undefined,
  procReadable,
  fdSecretReadable,
  uid: process.getuid?.(),
  allowed: await tcp("127.0.0.1", Number(process.env.PROBE_ALLOWED_PORT)),
  blockedLoopback: await tcp("127.0.0.1", Number(process.env.PROBE_BLOCKED_PORT)),
  blockedIpv6: await tcp("::1", Number(process.env.PROBE_BLOCKED_IPV6_PORT)),
  externalTcp: await tcp("1.1.1.1", 443),
  externalUdp: await udp("udp4", "1.1.1.1", 123),
  dnsUdp: await udp("udp4", "8.8.8.8", 53),
  ipv6Udp: await udp("udp6", "::1", Number(process.env.PROBE_BLOCKED_IPV6_PORT)),
  rawProbeAvailable,
  rawIpv4: spawnSync("python3", ["-c", "import socket; socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)"]).status === 0,
  rawIpv6: spawnSync("python3", ["-c", "import socket; socket.socket(socket.AF_INET6, socket.SOCK_RAW, socket.IPPROTO_RAW)"]).status === 0,
}));
`,
        { mode: 0o600 },
      );
      process.env.PROBE_PARENT_CREDENTIAL = "must-not-cross-boundary";
      const repoRoot = path.resolve(import.meta.dirname, "../../../..");
      const launch = sandboxCommand({
        uid: sandboxUid,
        allowedPorts: String(allowedPort),
        repoRoot,
        outputDir: directory,
        runtime: process.execPath,
        args: [probe],
      });
      const sentinelDirectory = mkdtempSync(path.join(tmpdir(), "sandbox-fd-"));
      const sentinelPath = path.join(sentinelDirectory, "sentinel");
      writeFileSync(sentinelPath, "fd-secret", { mode: 0o600 });
      const sentinelFd = openSync(sentinelPath, "r");
      const child = spawn(launch.command, launch.args, {
        cwd: repoRoot,
        env: scenarioChildEnvironment(process.env, {
          PROBE_PARENT_PID: String(process.pid),
          PROBE_ALLOWED_PORT: String(allowedPort),
          PROBE_BLOCKED_PORT: String(blockedPort),
          PROBE_BLOCKED_IPV6_PORT: String(blockedIpv6Port),
        }),
        stdio: ["ignore", "pipe", "pipe", sentinelFd],
      });
      closeSync(sentinelFd);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      await rm(sentinelDirectory, { recursive: true, force: true });
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        secretPresent: false,
        procReadable: false,
        fdSecretReadable: false,
        uid: Number(sandboxUid),
        allowed: true,
        blockedLoopback: false,
        blockedIpv6: false,
        externalTcp: false,
        externalUdp: false,
        dnsUdp: false,
        ipv6Udp: false,
        rawProbeAvailable: true,
        rawIpv4: false,
        rawIpv6: false,
      });
      const firewall = spawnSync(
        "sudo",
        ["-n", "sh", "-c", "iptables-save; ip6tables-save"],
        { encoding: "utf8" },
      );
      expect(firewall.status).toBe(0);
      expect(firewall.stdout).not.toContain("ELIZA_SBX_");
      expect(
        spawnSync("pgrep", ["-u", sandboxUid], { stdio: "ignore" }).status,
      ).not.toBe(0);

      const missingTools = mkdtempSync(
        path.join(tmpdir(), "sandbox-missing-tools-"),
      );
      symlinkSync("/usr/bin/id", path.join(missingTools, "id"));
      const setupScript = path.join(
        repoRoot,
        "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
      );
      const missingBwrap = spawnSync(
        "sudo",
        [
          "-n",
          "env",
          `PATH=${missingTools}`,
          "/bin/bash",
          setupScript,
          "setup",
        ],
        { encoding: "utf8" },
      );
      expect(missingBwrap.status).not.toBe(0);
      expect(missingBwrap.stderr).toContain("missing required command: bwrap");
      symlinkSync("/usr/bin/bwrap", path.join(missingTools, "bwrap"));
      const missingIptables = spawnSync(
        "sudo",
        [
          "-n",
          "env",
          `PATH=${missingTools}`,
          "/bin/bash",
          setupScript,
          "setup",
        ],
        { encoding: "utf8" },
      );
      expect(missingIptables.status).not.toBe(0);
      expect(missingIptables.stderr).toContain(
        "missing required command: iptables",
      );
      await rm(missingTools, { recursive: true, force: true });
    } finally {
      delete process.env.PROBE_PARENT_CREDENTIAL;
      allowed.close();
      blocked.close();
      blockedIpv6.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
