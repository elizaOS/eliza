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
  writeFileSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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

test("failed launch keeps environment bytes outside uploaded artifacts", async () => {
  const artifacts = await mkdtemp(path.join(tmpdir(), "sandbox-upload-"));
  const environmentPath = await writeSandboxEnvironment(artifacts, {
    ELIZA_SYNTHETIC_CONTROL_TOKEN: "private-test-token",
  });
  try {
    const child = spawn("sudo", ["-n", "/definitely-missing-launcher"], {
      env: { PATH: "/definitely-no-sudo" },
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => child.once("error", () => resolve()));
    expect(await readdir(artifacts)).toEqual([]);
    expect(await readFile(environmentPath, "utf8")).toContain(
      "private-test-token",
    );
    expect((await stat(environmentPath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(environmentPath))).mode & 0o777).toBe(
      0o700,
    );
  } finally {
    await rm(path.dirname(environmentPath), { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "setup rejects a non-executable command before accepting an executable tool",
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "sandbox-command-mode-"),
    );
    const executable = path.join(directory, "bwrap");
    const launcher = path.join(
      repoRoot,
      "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
    );
    try {
      await writeFile(executable, "#!/bin/sh\nprintf 'tool executed\\n'\n", {
        mode: 0o644,
      });
      const check = () =>
        spawnSync(
          "/bin/bash",
          [
            "-c",
            'source "$1"; export PATH="$2"; require_executable_command bwrap; bwrap',
            "sandbox-command-check",
            launcher,
            directory,
          ],
          { encoding: "utf8" },
        );
      const rejected = check();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("missing required command: bwrap");
      expect(rejected.stdout).toBe("");
      await chmod(executable, 0o755);
      const accepted = check();
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toBe("tool executed\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a repeated termination signal cannot interrupt owned cleanup",
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "sandbox-signal-control-"),
    );
    const reservedRoot = await mkdtemp(
      "/var/tmp/eliza-stability-sandbox.signal-",
    );
    const release = path.join(directory, "release");
    const launcher = path.join(
      repoRoot,
      "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
    );
    // Pause only the identity-release boundary; the real cleanup function and signal
    // delivery must finish removing the owned temporary root after a second TERM.
    const child = spawn(
      "/bin/bash",
      [
        "-c",
        `
source "$1"
SANDBOX_CLEANED=0
SANDBOX_USER=fixture-unused-identity
SANDBOX_ROOT="$2"
release="$3"
function /usr/sbin/userdel() {
  printf 'revoking\\n'
  while [ ! -f "$release" ]; do /bin/sleep 0.01; done
}
trap sandbox_cleanup EXIT
trap 'exit 143' TERM
printf 'ready\\n'
while :; do /bin/sleep 0.01; done
`,
        "sandbox-cleanup-signals",
        launcher,
        reservedRoot,
        release,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    async function waitFor(receipt: string) {
      const deadline = Date.now() + 2_000;
      while (
        !output.includes(receipt) &&
        Date.now() < deadline &&
        child.exitCode === null
      ) {
        await Bun.sleep(10);
      }
      expect(output).toContain(receipt);
    }
    try {
      await waitFor("ready\n");
      expect(child.kill("SIGTERM")).toBe(true);
      await waitFor("revoking\n");
      expect(child.kill("SIGTERM")).toBe(true);
      await writeFile(release, "release");
      await closed;
      expect(child.exitCode).toBe(143);
      expect(errors).toBe("");
      expect(existsSync(reservedRoot)).toBe(false);
    } finally {
      await writeFile(release, "release");
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await closed;
      await rm(directory, { recursive: true, force: true });
      await rm(reservedRoot, { recursive: true, force: true });
    }
  },
);

const hostedLinux =
  process.platform === "linux" &&
  process.env.ELIZA_STABILITY_LINUX_SANDBOX === "1";

async function createPrivateAttempt(prefix: string) {
  const outputRoot = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(outputRoot, 0o700);
  const attempt = path.join(outputRoot, "attempt-1");
  await mkdir(attempt, { mode: 0o700 });
  const acl = spawnSync("getfacl", ["-cpn", outputRoot], {
    encoding: "utf8",
  });
  if (acl.status !== 0) throw new Error(`getfacl failed: ${acl.stderr}`);
  const attemptAcl = spawnSync("getfacl", ["-cpn", attempt], {
    encoding: "utf8",
  });
  if (attemptAcl.status !== 0)
    throw new Error(`getfacl failed: ${attemptAcl.stderr}`);
  return {
    attempt,
    attemptAcl: attemptAcl.stdout,
    outputRoot,
    outputRootAcl: acl.stdout,
  };
}

function expectAclRestored(directory: string, expected: string) {
  const acl = spawnSync("getfacl", ["-cpn", directory], {
    encoding: "utf8",
  });
  expect(acl.status).toBe(0);
  expect(acl.stdout).toBe(expected);
}

test.skipIf(!hostedLinux)(
  "kernel boundary blocks proc, fd, network, AF_UNIX, socketpair, and io_uring escapes",
  async () => {
    const {
      attempt: directory,
      attemptAcl,
      outputRoot,
      outputRootAcl,
    } = await createPrivateAttempt("cloud-sandbox-proof-");
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
import { closeSync, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
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
// Keep subprocess output on regular files so the syscall probe does not
// depend on pipe implementations that can require forbidden socket channels.
let pythonProbeIndex = 0;
const runPython = (args) => {
  const prefix = process.argv[1] + ".python-" + pythonProbeIndex++;
  const out = openSync(prefix + ".out", "wx", 0o600);
  const err = openSync(prefix + ".err", "wx", 0o600);
  try {
    const result = spawnSync("/usr/bin/python3", args, { stdio: ["ignore", out, err] });
    return { ...result, stdout: readFileSync(prefix + ".out", "utf8"), stderr: readFileSync(prefix + ".err", "utf8") };
  } finally {
    closeSync(out); closeSync(err);
    unlinkSync(prefix + ".out"); unlinkSync(prefix + ".err");
  }
};
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
const syscallProbe = runPython(["-c", syscallPython]);
const syscallResult = syscallProbe.status === 0
  ? JSON.parse(syscallProbe.stdout)
  : { probeError: { status: syscallProbe.status, signal: syscallProbe.signal, stderr: syscallProbe.stderr, error: syscallProbe.error?.message, code: syscallProbe.error?.code } };
let procReadable = false;
try { readFileSync("/proc/" + process.env.PROBE_PARENT_PID + "/environ"); procReadable = true; } catch {}
let fdSecretReadable = false;
// The runtime may reuse the closed inherited descriptor for an internal pipe.
// Read only a regular file so testing descriptor closure cannot block the probe.
try { if (fstatSync(3).isFile()) fdSecretReadable = readFileSync(3, "utf8").includes("fd-secret"); } catch {}
let hostTmpReadable = false;
try { hostTmpReadable = readFileSync(process.env.PROBE_HOST_TMP_PATH, "utf8") === "must-be-masked"; } catch {}
const rawProbeAvailable = runPython(["--version"]).status === 0;
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
  rawIpv4: runPython(["-c", "import socket; socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)"]).status === 0,
  rawIpv6: runPython(["-c", "import socket; socket.socket(socket.AF_INET6, socket.SOCK_RAW, socket.IPPROTO_RAW)"]).status === 0,
  filesystemUnix: await unix(process.env.PROBE_FILESYSTEM_UNIX),
  abstractUnix: await unix("\\0" + process.env.PROBE_ABSTRACT_UNIX_NAME),
  syscallResult,
}));
`,
        // The fresh host UID must read this non-secret probe source. Private
        // credential and descriptor sentinels retain their separate 0600 mode.
        { mode: 0o644 },
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
      if (code !== 0) {
        process.stderr.write(`sandbox kernel probe exit=${code}: ${stderr}\n`);
      }
      expect(stderr).toBe("");
      expect(code).toBe(0);
      const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
      expect(result.uid).toBe(0);
      expect(result.hostUid).not.toBe(process.getuid?.());
      const capabilityResult: Record<string, unknown> = {
        ...result,
        uid: undefined,
        hostUid: undefined,
      };
      expect(capabilityResult).toEqual({
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

      // Use a readable launcher copy because AppArmor removes root DAC bypass
      // and the masked namespace must not depend on inherited stdin pipes.
      const setupSource = await readFile(
        path.join(
          repoRoot,
          "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
        ),
        "utf8",
      );
      const setupPath = path.join(hostTmpDirectory, "launcher.sh");
      await writeFile(setupPath, setupSource, { mode: 0o644 });
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
          setupPath,
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
          setupPath,
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
      expectAclRestored(directory, attemptAcl);
      expectAclRestored(outputRoot, outputRootAcl);
      await rm(outputRoot, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!hostedLinux)(
  "early bwrap failure removes the sandbox identity and kernel state",
  async () => {
    const {
      attempt: directory,
      attemptAcl,
      outputRoot,
      outputRootAcl,
    } = await createPrivateAttempt("cloud-sandbox-early-failure-");
    const failingRuntimePath = path.join(directory, "missing-interpreter");
    await writeFile(failingRuntimePath, "#!/eliza-missing-interpreter\n", {
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
      runtime: failingRuntimePath,
      args: [],
    });
    const child = spawn(launch.command, launch.args, {
      cwd: repoRoot,
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
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
      const code = await exit;
      expect(Number.isSafeInteger(sandboxUid)).toBe(true);
      expect(stdout).toBe("");
      expect(stderr).not.toContain("unbound variable");
      expect(code, stderr).toBe(1);
      expect(stderr).toContain("execvp");
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
      expectAclRestored(directory, attemptAcl);
      expectAclRestored(outputRoot, outputRootAcl);
    } finally {
      child.kill("SIGKILL");
      await rm(outputRoot, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!hostedLinux)(
  "forced teardown kills signal-resistant descendants and removes kernel state",
  async () => {
    const {
      attempt: directory,
      attemptAcl,
      outputRoot,
      outputRootAcl,
    } = await createPrivateAttempt("cloud-sandbox-teardown-");
    const readyPath = path.join(directory, "ready.json");
    const probePath = path.join(directory, "teardown-probe.ts");
    let child: ReturnType<typeof spawn> | undefined;
    let childClosed: Promise<void> | undefined;
    let primaryError: unknown;
    let primaryFailed = false;
    const cleanupErrors: unknown[] = [];
    let stderr = "";
    try {
      await writeFile(
        probePath,
        `
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  detached: false,
  stdio: "ignore",
});
process.on("SIGTERM", () => {});
const readyTemporary = process.env.TEARDOWN_READY_PATH + ".tmp";
writeFileSync(readyTemporary, JSON.stringify({
  uid: process.getuid?.(),
  hostUid: Number(process.env.ELIZA_STABILITY_SANDBOX_HOST_UID),
  pid: process.pid,
  descendantPid: descendant.pid,
}));
renameSync(readyTemporary, process.env.TEARDOWN_READY_PATH);
setInterval(() => {}, 1000);
`,
        // The fresh host UID must read this non-secret probe source. Private
        // credential and descriptor sentinels retain their separate 0600 mode.
        { mode: 0o644 },
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
      child = spawn(launch.command, launch.args, {
        cwd: repoRoot,
        detached: true,
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child.pid) throw new Error("sandbox teardown probe omitted PGID");
      childClosed = new Promise<void>((resolve, reject) => {
        child?.once("error", reject);
        child?.once("close", () => resolve());
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      let ready:
        | { uid: number; hostUid: number; pid: number; descendantPid: number }
        | undefined;
      const readyDeadline = Date.now() + 15_000;
      while (!ready && Date.now() < readyDeadline) {
        if (child.exitCode !== null || child.signalCode !== null) break;
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
      if (!ready) {
        process.stderr.write(
          `sandbox teardown readiness failed: exit=${child.exitCode} signal=${child.signalCode} stderr=${stderr}\n`,
        );
        throw new Error(
          `sandbox teardown probe did not become ready: exit=${child.exitCode} signal=${child.signalCode} stderr=${stderr}`,
        );
      }
      expect(ready.uid).toBe(0);
      expect(ready.hostUid).not.toBe(process.getuid?.());
      expect(
        spawnSync("sudo", ["-n", "kill", "-s", "TERM", "--", `-${child.pid}`], {
          stdio: "ignore",
        }).status,
      ).toBe(0);
      const closed = await Promise.race([
        childClosed.then(() => true),
        Bun.sleep(10_000).then(() => false),
      ]);
      expect(closed).toBe(true);
      const retainedStat = await stat(readyPath);
      if (!process.getuid) throw new Error("Linux requires process.getuid");
      expect(retainedStat.uid).toBe(process.getuid());
      expect(retainedStat.gid).toBe((await stat(directory)).gid);
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
    } catch (error) {
      // error-policy:J1 The test boundary reports primary and cleanup failures together below.
      primaryError = error;
      primaryFailed = true;
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        spawnSync("sudo", ["-n", "kill", "-s", "TERM", "--", `-${child.pid}`], {
          stdio: "ignore",
        });
        try {
          await Promise.race([
            childClosed,
            Bun.sleep(10_000).then(() => {
              throw new Error(
                "sandbox cleanup did not close after termination",
              );
            }),
          ]);
        } catch (error) {
          // error-policy:J6 Retain cleanup failure alongside the original probe failure.
          cleanupErrors.push(error);
        }
      }
      for (const [target, expected] of [
        [directory, attemptAcl],
        [outputRoot, outputRootAcl],
      ] as const) {
        try {
          expectAclRestored(target, expected);
        } catch (error) {
          // error-policy:J6 Both ACL failures remain visible without replacing the probe failure.
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length === 0) {
        try {
          await rm(outputRoot, { recursive: true, force: true });
        } catch (error) {
          // error-policy:J6 Artifact removal must not replace the original probe failure.
          cleanupErrors.push(error);
        }
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        primaryFailed ? [primaryError, ...cleanupErrors] : cleanupErrors,
        `sandbox teardown failed; launcher stderr=${stderr}`,
      );
    }
    if (primaryFailed) throw primaryError;
  },
  30_000,
);

test.skipIf(!hostedLinux)(
  "repository search grants preserve private data and restore existing group access",
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "sandbox-repo-search-"),
    );
    const launcher = path.join(
      repoRoot,
      "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
    );
    const script = `
source "$1"
directory="$2"
caller_uid="$3"
name="eliza-search-${process.pid}-$RANDOM"
cleanup_fixture() {
  /usr/sbin/userdel "$name" 2>/dev/null || true
}
/usr/sbin/useradd --system --no-create-home --shell /usr/sbin/nologin "$name"
trap cleanup_fixture EXIT
SANDBOX_USER="$name"
SANDBOX_UID="$(/usr/bin/id -u "$name")"
SANDBOX_GID="$(/usr/bin/id -g "$name")"
SANDBOX_CALLER_UID="$caller_uid"
SANDBOX_CLEANED=0
/bin/chmod 0750 "$directory"
/bin/mkdir "$directory/repo"
/bin/chown "$caller_uid" "$directory/repo"
/bin/chmod 0700 "$directory/repo"
/bin/echo private > "$directory/secret"
/bin/chmod 0600 "$directory/secret"
before="$(/usr/bin/getfacl -cpn "$directory")"
repo_before="$(/usr/bin/getfacl -cpn "$directory/repo")"
grant_search_acls "$directory/repo"
grant_search_acls "$directory/repo"
/usr/bin/setpriv --reuid "$SANDBOX_UID" --regid "$SANDBOX_GID" --clear-groups -- /usr/bin/test -x "$directory/repo"
if /usr/bin/setpriv --reuid "$SANDBOX_UID" --regid "$SANDBOX_GID" --clear-groups -- /usr/bin/test -r "$directory/repo"; then exit 91; fi
if /usr/bin/setpriv --reuid "$SANDBOX_UID" --regid "$SANDBOX_GID" --clear-groups -- /bin/cat "$directory/secret"; then exit 92; fi
/usr/bin/getfacl -cpn "$directory" | /usr/bin/grep -qx 'group::r-x'
sandbox_cleanup || exit 94
set -e
[ "$(/usr/bin/getfacl -cpn "$directory")" = "$before" ]
[ "$(/usr/bin/getfacl -cpn "$directory/repo")" = "$repo_before" ]
if /usr/bin/getent passwd "$name" >/dev/null; then exit 93; fi
echo restored
`;
    try {
      const result = spawnSync(
        "sudo",
        [
          "-n",
          "/bin/bash",
          "-c",
          script,
          "repository-search-test",
          launcher,
          directory,
          String(process.getuid?.()),
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("restored");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(!hostedLinux)(
  "a preexisting UID process retains its identity without being terminated",
  () => {
    const launcher = path.join(
      repoRoot,
      "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
    );
    const script = `
source "$1"
name="eliza-collision-${process.pid}-$RANDOM"
pid=""
cleanup_fixture() {
  if [ -n "$pid" ]; then
    /bin/kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  /usr/sbin/userdel "$name" 2>/dev/null || true
}
/usr/sbin/useradd --system --no-create-home --shell /usr/sbin/nologin "$name"
trap cleanup_fixture EXIT
uid="$(/usr/bin/id -u "$name")"
gid="$(/usr/bin/id -g "$name")"
/usr/bin/setpriv --reuid "$uid" --regid "$gid" --clear-groups -- /bin/sleep 30 &
pid=$!
for _ in $(/usr/bin/seq 1 100); do
  if /usr/bin/pgrep -u "$uid" >/dev/null; then break; fi
  /bin/sleep 0.01
done
/usr/bin/pgrep -u "$uid" >/dev/null
SANDBOX_USER="$name"
SANDBOX_CLEANED=0
if require_unused_sandbox_uid "$uid"; then exit 90; fi
if sandbox_cleanup; then exit 91; fi
/usr/bin/getent passwd "$name" >/dev/null
/bin/kill -0 "$pid"
/usr/bin/pgrep -u "$uid" >/dev/null
echo preserved
`;
    const result = spawnSync(
      "sudo",
      ["-n", "/bin/bash", "-c", script, "uid-collision-test", launcher],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("preserved");
    expect(result.stderr).toContain("identity remains reserved");
  },
  20_000,
);

// The real cleanup function owns real user/firewall/ACL fixtures. Only the
// process observer models a survivor or an OS observation failure after SIGKILL.
for (const observerStatus of [0, 2]) {
  test.skipIf(!hostedLinux)(
    `failed process reaping (${observerStatus}) preserves identity and containment`,
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "sandbox-survivor-"));
      const launcher = path.join(
        repoRoot,
        "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
      );
      const script = `
source "$1"
name="eliza-test-${process.pid}-$RANDOM"
chain="ELIZA_TEST_$$"
uid=""
cleanup_fixture() {
  /usr/sbin/iptables -w 5 -D OUTPUT -m owner --uid-owner "$uid" -j "$chain" 2>/dev/null || true
  /usr/sbin/iptables -w 5 -F "$chain" 2>/dev/null || true
  /usr/sbin/iptables -w 5 -X "$chain" 2>/dev/null || true
  /usr/bin/setfacl -x "u:$uid" "$2" 2>/dev/null || true
  /usr/sbin/userdel "$name" 2>/dev/null || true
}
/usr/sbin/useradd --system --no-create-home --shell /usr/sbin/nologin "$name"
uid="$(/usr/bin/id -u "$name")"
trap 'cleanup_fixture "$1" "$2"' EXIT
/usr/sbin/iptables -w 5 -N "$chain"
/usr/sbin/iptables -w 5 -A "$chain" -j REJECT
/usr/sbin/iptables -w 5 -A OUTPUT -m owner --uid-owner "$uid" -j "$chain"
/usr/bin/setfacl -m "u:$uid:rwx" "$2"
acl="$(/usr/bin/getfacl -cpn "$2")"
SANDBOX_USER="$name"
SANDBOX_UID="$uid"
SANDBOX_CALLER_UID="$(/usr/bin/stat -c %u "$2")"
SANDBOX_OUTPUT_DIR="$2"
SANDBOX_CHAIN="$chain"
SANDBOX_IPV4_CHAIN=1
SANDBOX_IPV4_JUMP=1
SANDBOX_CLEANED=0
sandbox_uid_has_processes() { return ${observerStatus}; }
if sandbox_cleanup; then exit 90; fi
set -e
/usr/bin/getent passwd "$name" >/dev/null
/usr/sbin/iptables -w 5 -C OUTPUT -m owner --uid-owner "$uid" -j "$chain"
[ "$(/usr/bin/getfacl -cpn "$2")" = "$acl" ]
echo preserved
`;
      try {
        const result = spawnSync(
          "sudo",
          [
            "-n",
            "/bin/bash",
            "-c",
            script,
            "survivor-test",
            launcher,
            directory,
          ],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe("preserved");
        expect(result.stderr).toContain(
          "restrictions remain for operator cleanup",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );
}
