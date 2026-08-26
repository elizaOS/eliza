/**
 * Proves the Linux stability sandbox rejects credential, process, descriptor,
 * and kernel-network escapes while preserving declared mock-proxy access.
 */

import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loopbackPorts,
  sandboxCommand,
  scenarioChildEnvironment,
  writeSandboxEnvironment,
} from "./linux-sandbox.ts";

function resolveRepositoryRoot(start: string): string {
  let candidate = path.resolve(start);
  while (true) {
    if (
      existsSync(path.join(candidate, "package.json")) &&
      existsSync(path.join(candidate, "packages/cloud/e2e/package.json")) &&
      existsSync(
        path.join(
          candidate,
          "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
        ),
      )
    ) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new Error(`repository root not found above ${start}`);
    }
    candidate = parent;
  }
}

const repoRoot = resolveRepositoryRoot(import.meta.dirname);
const sandboxLauncherPath = path.join(
  repoRoot,
  "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
);

test("sandbox launcher resolves from the Cloud e2e workspace root", () => {
  const packageManifestPath = path.join(
    repoRoot,
    "packages/cloud/e2e/package.json",
  );
  expect(
    (
      JSON.parse(readFileSync(packageManifestPath, "utf8")) as {
        name?: unknown;
      }
    ).name,
  ).toBe("@elizaos/cloud-e2e");
  expect(existsSync(sandboxLauncherPath)).toBe(true);
  const launcher = readFileSync(sandboxLauncherPath, "utf8");
  expect(launcher).toContain(
    '/usr/bin/setpriv --reuid "$uid" --regid "$uid" --clear-groups --',
  );
  expect(launcher).toContain(
    "/usr/bin/bwrap --die-with-parent --new-session --unshare-user",
  );
  expect(launcher).toContain(
    '--setenv ELIZA_STABILITY_SANDBOX_HOST_UID "$uid"',
  );
  expect(launcher).toContain("--uid 0 --gid 0 --cap-drop ALL --seccomp 3");
});

test("credential-minimal child environment rejects ambient runner secrets", () => {
  const environment = scenarioChildEnvironment(
    {
      PATH: "/bin",
      GITHUB_TOKEN: "runner-token",
      OPENAI_API_KEY: "provider-key",
      OPENAI_BASE_URL: "http://127.0.0.1:4311",
      DATABASE_PASSWORD: "database-secret",
      NODE_ENV: "test",
      SAFE_SETTING: "discarded",
    },
    { OPENAI_API_KEY: "sandbox-proxy-credential" },
  );
  expect(environment).toEqual({
    NODE_ENV: "test",
    OPENAI_API_KEY: "sandbox-proxy-credential",
    OPENAI_BASE_URL: "http://127.0.0.1:4311",
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
    enabled: true,
    allowedPorts: "4311",
    repoRoot: "/repo",
    outputDir: "/output",
    environmentPath: "/output/.sandbox-environment-test.bin",
    callerHome: "/home/caller",
    callerUid: 1000,
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

const hostedLinux =
  process.platform === "linux" &&
  process.env.ELIZA_STABILITY_LINUX_SANDBOX === "1";

test.skipIf(!hostedLinux)(
  "kernel boundary blocks proc, fd, network, AF_UNIX, socketpair, and io_uring escapes",
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cloud-sandbox-proof-"),
    );
    const hostTmpDirectory = await mkdtemp(
      path.join(tmpdir(), "cloud-sandbox-host-ipc-"),
    );
    await chmod(hostTmpDirectory, 0o755);
    const hostTmpMarkerPath = path.join(hostTmpDirectory, "world-readable");
    await writeFile(hostTmpMarkerPath, "must-be-masked", { mode: 0o644 });
    const allowed = createServer((socket) => socket.end("allowed"));
    const blocked = createServer((socket) => socket.end("blocked"));
    const blockedIpv6 = createServer((socket) => socket.end("blocked-ipv6"));
    const filesystemUnix = createServer((socket) => socket.end("host-unix"));
    const abstractUnix = createServer((socket) => socket.end("host-abstract"));
    const filesystemUnixPath = path.join(directory, "host-delegation.sock");
    const filesystemUnixDatagramPath = path.join(
      directory,
      "host-delegation-dgram.sock",
    );
    const datagramReadyPath = path.join(directory, "host-dgram-ready");
    const abstractUnixPath = `\0eliza-stability-${process.pid}-${Date.now()}`;
    const datagramServer = spawn(
      "python3",
      [
        "-c",
        [
          "import pathlib, socket, sys",
          "server = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)",
          "server.bind(sys.argv[1])",
          "pathlib.Path(sys.argv[2]).write_text('ready')",
          "server.recv(1)",
        ].join("\n"),
        filesystemUnixDatagramPath,
        datagramReadyPath,
      ],
      { stdio: "ignore" },
    );
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
      new Promise<void>((resolve, reject) => {
        filesystemUnix.once("error", reject);
        filesystemUnix.listen(filesystemUnixPath, resolve);
      }),
      new Promise<void>((resolve, reject) => {
        abstractUnix.once("error", reject);
        abstractUnix.listen(abstractUnixPath, resolve);
      }),
    ]);
    try {
      const datagramReadyDeadline = Date.now() + 5_000;
      while (Date.now() < datagramReadyDeadline) {
        try {
          if ((await readFile(datagramReadyPath, "utf8")) === "ready") break;
        } catch (error) {
          // error-policy:J3 The ready marker is absent until the host datagram endpoint is bound.
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
        await Bun.sleep(25);
      }
      expect(await readFile(datagramReadyPath, "utf8")).toBe("ready");
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
const unix = (path) => new Promise((resolve) => {
  const socket = connect({ path });
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
const syscallPython = [
  "import ctypes, json, os, socket",
  "libc = ctypes.CDLL(None, use_errno=True)",
  "fds = (ctypes.c_int * 2)()",
  "ctypes.set_errno(0)",
  "socketpair_result = libc.syscall(53, socket.AF_UNIX, socket.SOCK_DGRAM, 0, fds)",
  "socketpair_errno = ctypes.get_errno()",
  "socketpair_reconnect = False",
  "if socketpair_result == 0:",
  "    left = socket.socket(fileno=fds[0])",
  "    right = socket.socket(fileno=fds[1])",
  "    try:",
  "        left.connect(os.environ['PROBE_FILESYSTEM_UNIX_DGRAM'])",
  "        socketpair_reconnect = True",
  "    except OSError:",
  "        pass",
  "    left.close()",
  "    right.close()",
  "def denied(nr, *args):",
  "    ctypes.set_errno(0)",
  "    result = libc.syscall(nr, *args)",
  "    return {'result': result, 'errno': ctypes.get_errno()}",
  "print(json.dumps({'socketpairResult': socketpair_result, 'socketpairErrno': socketpair_errno, 'socketpairReconnect': socketpair_reconnect, 'x32Socketpair': denied(0x40000000 | 53, socket.AF_UNIX, socket.SOCK_DGRAM, 0, fds), 'ioUringSetup': denied(425, 1, 0), 'ioUringEnter': denied(426, -1, 0, 0, 0, 0, 0), 'ioUringRegister': denied(427, -1, 0, 0, 0)}))",
].join("\\n");
const syscallProbe = spawnSync("python3", ["-c", syscallPython], { encoding: "utf8" });
const syscallResult = syscallProbe.status === 0
  ? JSON.parse(syscallProbe.stdout)
  : { probeError: syscallProbe.stderr };
let procReadable = false;
try { readFileSync("/proc/" + process.env.PROBE_PARENT_PID + "/environ"); procReadable = true; } catch {}
let fdSecretReadable = false;
try { fdSecretReadable = readFileSync(3, "utf8").includes("fd-secret"); } catch {}
let hostTmpReadable = false;
try { hostTmpReadable = readFileSync(process.env.PROBE_HOST_TMP_PATH, "utf8") === "must-be-masked"; } catch {}
const rawProbeAvailable = spawnSync("python3", ["--version"]).status === 0;
console.log(JSON.stringify({
  secretPresent: process.env.PROBE_PARENT_CREDENTIAL !== undefined,
  procReadable,
  fdSecretReadable,
  hostTmpReadable,
  uid: process.getuid?.(),
  hostUid: Number(process.env.ELIZA_STABILITY_SANDBOX_HOST_UID),
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
  filesystemUnix: await unix(process.env.PROBE_FILESYSTEM_UNIX),
  abstractUnix: await unix("\\0" + process.env.PROBE_ABSTRACT_UNIX_NAME),
  syscallResult,
}));
`,
        { mode: 0o600 },
      );
      process.env.PROBE_PARENT_CREDENTIAL = "must-not-cross-boundary";
      const launch = sandboxCommand({
        enabled: true,
        allowedPorts: String(allowedPort),
        repoRoot,
        outputDir: directory,
        environmentPath: await writeSandboxEnvironment(
          directory,
          scenarioChildEnvironment(process.env, {
            PROBE_PARENT_PID: String(process.pid),
            PROBE_ALLOWED_PORT: String(allowedPort),
            PROBE_BLOCKED_PORT: String(blockedPort),
            PROBE_BLOCKED_IPV6_PORT: String(blockedIpv6Port),
            PROBE_FILESYSTEM_UNIX: filesystemUnixPath,
            PROBE_FILESYSTEM_UNIX_DGRAM: filesystemUnixDatagramPath,
            PROBE_HOST_TMP_PATH: hostTmpMarkerPath,
            PROBE_ABSTRACT_UNIX_NAME: abstractUnixPath.slice(1),
          }),
        ),
        callerHome: process.env.HOME ?? "",
        callerUid: process.getuid?.() ?? 0,
        runtime: process.execPath,
        args: [probe],
      });
      const sentinelDirectory = mkdtempSync(path.join(tmpdir(), "sandbox-fd-"));
      const sentinelPath = path.join(sentinelDirectory, "sentinel");
      writeFileSync(sentinelPath, "fd-secret", { mode: 0o600 });
      const sentinelFd = openSync(sentinelPath, "r");
      const child = spawn(launch.command, launch.args, {
        cwd: repoRoot,
        env: { PATH: process.env.PATH },
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
      const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
      expect(result.uid).toBe(0);
      expect(result.hostUid).not.toBe(process.getuid?.());
      expect({ ...result, uid: undefined, hostUid: undefined }).toEqual({
        secretPresent: false,
        procReadable: false,
        fdSecretReadable: false,
        hostTmpReadable: false,
        uid: undefined,
        hostUid: undefined,
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
        filesystemUnix: false,
        abstractUnix: false,
        syscallResult: {
          socketpairResult: -1,
          socketpairErrno: 1,
          socketpairReconnect: false,
          x32Socketpair: { result: -1, errno: 1 },
          ioUringSetup: { result: -1, errno: 1 },
          ioUringEnter: { result: -1, errno: 1 },
          ioUringRegister: { result: -1, errno: 1 },
        },
      });
      const firewall = spawnSync(
        "sudo",
        ["-n", "sh", "-c", "iptables-save; ip6tables-save"],
        { encoding: "utf8" },
      );
      expect(firewall.status).toBe(0);
      expect(firewall.stdout).not.toContain("ELIZA_SBX_");
      expect(
        spawnSync("pgrep", ["-u", String(result.hostUid)], {
          stdio: "ignore",
        }).status,
      ).not.toBe(0);
      const accessControl = spawnSync("getfacl", ["-R", directory], {
        encoding: "utf8",
      });
      expect(accessControl.status).toBe(0);
      expect(accessControl.stdout).not.toContain(
        `user:${String(result.hostUid)}:`,
      );

      const setupScript = path.join(
        repoRoot,
        "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
      );
      const missingBwrap = spawnSync(
        "sudo",
        [
          "-n",
          "/usr/bin/bwrap",
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--ro-bind",
          "/dev/null",
          "/usr/bin/bwrap",
          "/bin/bash",
          setupScript,
          "setup",
        ],
        { encoding: "utf8" },
      );
      expect(missingBwrap.status).not.toBe(0);
      expect(missingBwrap.stderr).toContain("missing required command: bwrap");
      const missingIptables = spawnSync(
        "sudo",
        [
          "-n",
          "/usr/bin/bwrap",
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--ro-bind",
          "/dev/null",
          "/usr/sbin/iptables",
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
    } finally {
      delete process.env.PROBE_PARENT_CREDENTIAL;
      allowed.close();
      blocked.close();
      blockedIpv6.close();
      filesystemUnix.close();
      abstractUnix.close();
      datagramServer.kill("SIGKILL");
      await rm(hostTmpDirectory, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!hostedLinux)(
  "early bwrap failure removes the sandbox identity and kernel state",
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cloud-sandbox-early-failure-"),
    );
    const fakeBwrapPath = path.join(directory, "failing-bwrap");
    await writeFile(fakeBwrapPath, "#!/bin/sh\n/bin/sleep 1\nexit 91\n", {
      mode: 0o755,
    });
    const environmentPath = await writeSandboxEnvironment(
      directory,
      scenarioChildEnvironment(process.env, {}),
    );
    const launch = sandboxCommand({
      enabled: true,
      allowedPorts: "9",
      repoRoot,
      outputDir: directory,
      environmentPath,
      callerHome: process.env.HOME ?? "",
      callerUid: process.getuid?.() ?? 0,
      runtime: "/bin/true",
      args: [],
    });
    const child = spawn(
      launch.command,
      [
        "-n",
        "/usr/bin/bwrap",
        "--bind",
        "/",
        "/",
        "--dev-bind",
        "/dev",
        "/dev",
        "--proc",
        "/proc",
        "--ro-bind",
        fakeBwrapPath,
        "/usr/bin/bwrap",
        ...launch.args.slice(1),
      ],
      {
        cwd: repoRoot,
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    try {
      let sandboxUid: number | undefined;
      const identityDeadline = Date.now() + 5_000;
      while (sandboxUid === undefined && Date.now() < identityDeadline) {
        const passwd = spawnSync("getent", ["passwd"], { encoding: "utf8" });
        if (passwd.status !== 0) throw new Error("getent passwd failed");
        const record = passwd.stdout
          .split("\n")
          .find((line) => line.startsWith("eliza-sbx-"));
        if (record) sandboxUid = Number(record.split(":")[2]);
        if (sandboxUid === undefined) await Bun.sleep(10);
      }
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(Number.isSafeInteger(sandboxUid)).toBe(true);
      expect(stdout).toBe("");
      expect(stderr).not.toContain("unbound variable");
      expect(code).toBe(91);
      expect(existsSync(environmentPath)).toBe(false);
      expect(
        spawnSync("pgrep", ["-u", String(sandboxUid)], {
          stdio: "ignore",
        }).status,
      ).not.toBe(0);
      expect(
        spawnSync("getent", ["passwd", String(sandboxUid)], {
          stdio: "ignore",
        }).status,
      ).not.toBe(0);
      const accessControl = spawnSync("getfacl", ["-R", directory], {
        encoding: "utf8",
      });
      expect(accessControl.status).toBe(0);
      expect(accessControl.stdout).not.toContain(`user:${sandboxUid}:`);
      const firewall = spawnSync(
        "sudo",
        ["-n", "sh", "-c", "iptables-save; ip6tables-save"],
        { encoding: "utf8" },
      );
      expect(firewall.status).toBe(0);
      expect(firewall.stdout).not.toContain("ELIZA_SBX_");
    } finally {
      child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!hostedLinux)(
  "forced teardown kills signal-resistant descendants and removes kernel state",
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cloud-sandbox-teardown-"),
    );
    const readyPath = path.join(directory, "ready.json");
    const probePath = path.join(directory, "teardown-probe.ts");
    try {
      await writeFile(
        probePath,
        `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  detached: false,
  stdio: "ignore",
});
process.on("SIGTERM", () => {});
writeFileSync(process.env.TEARDOWN_READY_PATH, JSON.stringify({
  uid: process.getuid?.(),
  hostUid: Number(process.env.ELIZA_STABILITY_SANDBOX_HOST_UID),
  pid: process.pid,
  descendantPid: descendant.pid,
}));
setInterval(() => {}, 1000);
`,
        { mode: 0o600 },
      );
      const environmentPath = await writeSandboxEnvironment(
        directory,
        scenarioChildEnvironment(process.env, {
          TEARDOWN_READY_PATH: readyPath,
        }),
      );
      const launch = sandboxCommand({
        enabled: true,
        allowedPorts: "9",
        repoRoot,
        outputDir: directory,
        environmentPath,
        callerHome: process.env.HOME ?? "",
        callerUid: process.getuid?.() ?? 0,
        runtime: process.execPath,
        args: [probePath],
      });
      const child = spawn(launch.command, launch.args, {
        cwd: repoRoot,
        detached: true,
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child.pid) throw new Error("sandbox teardown probe omitted PGID");
      let ready:
        | { uid: number; hostUid: number; pid: number; descendantPid: number }
        | undefined;
      const readyDeadline = Date.now() + 15_000;
      while (!ready && Date.now() < readyDeadline) {
        try {
          ready = JSON.parse(await readFile(readyPath, "utf8")) as typeof ready;
        } catch (error) {
          // error-policy:J3 The ready file is untrusted until an atomic complete JSON write is observed.
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
          await Bun.sleep(25);
        }
      }
      if (!ready)
        throw new Error("sandbox teardown probe did not become ready");
      expect(ready.uid).toBe(0);
      expect(ready.hostUid).not.toBe(process.getuid?.());
      expect(
        spawnSync("sudo", ["-n", "kill", "-TERM", `-${child.pid}`], {
          stdio: "ignore",
        }).status,
      ).toBe(0);
      const closed = await Promise.race([
        new Promise<boolean>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", () => resolve(true));
        }),
        Bun.sleep(10_000).then(() => false),
      ]);
      expect(closed).toBe(true);
      expect(
        spawnSync("pgrep", ["-u", String(ready.hostUid)], {
          stdio: "ignore",
        }).status,
      ).not.toBe(0);
      expect(
        spawnSync("getent", ["passwd", String(ready.hostUid)], {
          stdio: "ignore",
        }).status,
      ).not.toBe(0);
      const accessControl = spawnSync("getfacl", ["-R", directory], {
        encoding: "utf8",
      });
      expect(accessControl.status).toBe(0);
      expect(accessControl.stdout).not.toContain(`user:${ready.hostUid}:`);
      const firewall = spawnSync(
        "sudo",
        ["-n", "sh", "-c", "iptables-save; ip6tables-save"],
        { encoding: "utf8" },
      );
      expect(firewall.status).toBe(0);
      expect(firewall.stdout).not.toContain("ELIZA_SBX_");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
