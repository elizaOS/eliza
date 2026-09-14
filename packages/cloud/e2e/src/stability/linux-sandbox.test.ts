/**
 * Proves the Linux stability sandbox rejects credential, process, descriptor,
 * and kernel-network escapes while preserving declared mock-proxy access.
 * Real guardian/FIFO fixtures remain explicitly unsigned; authenticated native
 * scenario acceptance belongs to the canonical adapter and verifier lane.
 */

import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { runFifoProcess } from "./fifo-process.ts";
import {
  assertLinuxSandboxCapabilities,
  assertSandboxReadableSource,
  loopbackPorts,
  NATIVE_STABILITY_TIMEOUT_MS,
  sandboxCommand,
  scenarioChildEnvironment,
  writeSandboxEnvironment,
} from "./linux-sandbox.ts";
import { createScenarioProcessGroup } from "./scenario-process-group.ts";

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
const kernelFixtureTimeoutMs = 2 * NATIVE_STABILITY_TIMEOUT_MS + 60_000;
const fixtureReceiptPrefix = "ELIZA_KERNEL_FIXTURE_TERMINAL=";
let kernelFixtureUnproven = false;

test("private source ancestors reject before privileged capability allocation", async () => {
  const directory = await mkdtemp(path.join("/tmp", "private-sandbox-source-"));
  const source = path.join(directory, "source");
  const marker = path.join(directory, "unexpected-dispatch");
  const launcher = path.join(directory, "sentinel-launcher");
  const previous = process.env.ELIZA_STABILITY_LINUX_SANDBOX;
  try {
    await mkdir(source, { mode: 0o755 });
    await writeFile(launcher, `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    });
    expect(() => assertSandboxReadableSource(source)).toThrow(
      "sandbox-readable source workspace",
    );
    if (process.platform === "linux") {
      process.env.ELIZA_STABILITY_LINUX_SANDBOX = "1";
      expect(() =>
        assertLinuxSandboxCapabilities(source, "deterministic-mock", launcher),
      ).toThrow("sandbox-readable source workspace");
      expect(existsSync(marker)).toBe(false);
    }
    await chmod(directory, 0o755);
    assertSandboxReadableSource(source);
    await chmod(source, 0o700);
    expect(() => assertSandboxReadableSource(source)).toThrow(
      "sandbox-readable source workspace",
    );
  } finally {
    if (previous === undefined)
      delete process.env.ELIZA_STABILITY_LINUX_SANDBOX;
    else process.env.ELIZA_STABILITY_LINUX_SANDBOX = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

/** Calls the real guardian as an explicitly unsigned kernel fixture, never a native acceptance token. */
async function runKernelFixture(
  launch: ReturnType<typeof sandboxCommand>,
  sentinelPath?: string,
  forceReadyPath?: string,
) {
  if (kernelFixtureUnproven)
    throw new Error(
      "Prior kernel fixture cleanup is unproven; refusing another owner",
    );
  kernelFixtureUnproven = true;
  const runIndex = launch.args.indexOf("run");
  if (runIndex < 1)
    throw new Error(
      "Kernel fixture requires the production supervisor argument contract",
    );
  const script = launch.args[runIndex - 1];
  const supervisor = launch.args[runIndex + 1];
  if (typeof script !== "string" || typeof supervisor !== "string") {
    throw new Error(
      "Kernel fixture omitted the launcher or original supervisor identity",
    );
  }
  const argumentsJson = JSON.stringify(launch.args.slice(runIndex + 2));
  const driver = `import importlib.util,json,os,pathlib,sys,signal,time,select
script,arguments,supervisor,sentinel,force_ready=sys.argv[1:]
helper=pathlib.Path(script).with_name('stability-sandbox-owner.py')
spec=importlib.util.spec_from_file_location('owned_kernel_fixture',helper)
module=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=module
spec.loader.exec_module(module)
module.require_root()
if sentinel:
 fd=os.open(sentinel,os.O_RDONLY|os.O_NOFOLLOW)
 if fd!=3:
  os.dup2(fd,3)
  os.close(fd)
 os.set_inheritable(3,True)
if force_ready:
 prior=set(pathlib.Path('/run').glob('eliza-stability-owner-*'))
 reader,writer=os.pipe()
 pid=os.fork()
 if pid==0:
  os.close(reader)
  os.write(writer,module.canonical(module.process_identity(os.getpid())))
  os.close(writer)
  try:
   module.controller(script,json.loads(arguments),json.loads(supervisor),True)
  finally:
   os._exit(70)
 os.close(writer)
 pidfd=os.pidfd_open(pid)
 reaped=False
 try:
  poller=select.poll();poller.register(reader,select.POLLIN|select.POLLHUP)
  if not poller.poll(5000):raise RuntimeError('fixture controller identity deadline')
  identity=json.loads(os.read(reader,4096));os.close(reader)
  deadline=time.monotonic()+600
  while not pathlib.Path(force_ready).exists():
   if time.monotonic()>=deadline:raise RuntimeError('forced fixture readiness deadline')
   if os.waitpid(pid,os.WNOHANG)[0]:
    reaped=True
    raise RuntimeError('controller exited before payload readiness')
   time.sleep(.05)
  owners=[]
  for directory in set(pathlib.Path('/run').glob('eliza-stability-owner-*'))-prior:
   rows=module.Journal(directory).read()
   if any(row['event']=='owner-started' and row['data']['controllerIdentity']==identity for row in rows):owners.append(directory)
  if len(owners)!=1:raise RuntimeError('forced fixture owner identity is not unique')
  directory=owners[0]
  rows=module.Journal(directory).read()
  names=next(row['data']['units'] for row in rows if row['event']=='owner-started')
  signal.pidfd_send_signal(pidfd,signal.SIGTERM)
  _,status=os.waitpid(pid,0);reaped=True
  if not os.WIFSIGNALED(status) or os.WTERMSIG(status)!=signal.SIGTERM:raise RuntimeError('controller did not die by owned TERM')
  deadline=time.monotonic()+610
  while True:
   rows=module.Journal(directory).read()
   if rows and rows[-1]['event']=='cleanup-verified':break
   if time.monotonic()>=deadline:raise RuntimeError('forced fixture cleanup deadline')
   time.sleep(.1)
  while True:
   states={}
   for key,unit in names.items():
    remaining=deadline-time.monotonic()
    if remaining<=0:raise RuntimeError('owned manager terminal deadline')
    text=module.command(['/usr/bin/systemctl','show',unit,'--property=LoadState,ActiveState,SubState,ControlGroup,Job,MainPID,ControlPID'],timeout=min(10,remaining)).stdout.decode('utf-8',errors='strict')
    fields=dict(line.split('=',1) for line in text.splitlines() if '=' in line)
    if not {'LoadState','ActiveState','SubState','ControlGroup','Job'}<=fields.keys():raise RuntimeError('manager omitted terminal state')
    if key in ('guardian','collector') and not {'MainPID','ControlPID'}<=fields.keys():raise RuntimeError('manager omitted service process state')
    states[key]=fields
   if all(v['ActiveState'] in ('inactive','failed') and not v['ControlGroup'] and not v['Job'] and v.get('MainPID','0')=='0' and v.get('ControlPID','0')=='0' for v in states.values()):break
   time.sleep(.1)
  result={'directory':str(directory),'units':names,'controllerSignal':'SIGTERM','controllerIdentity':identity,'nativeLedgerQualified':False,'observedUnitStates':states}
 finally:
  if not reaped:
   signal.pidfd_send_signal(pidfd,signal.SIGKILL)
   os.waitpid(pid,0)
  os.close(pidfd)
else:
 result=module.controller(script,json.loads(arguments),json.loads(supervisor),True)
 if result['terminal']['nativeLedgerQualified'] is not False:
  raise RuntimeError('kernel fixture must remain explicitly unsigned')
records=module.Journal(result['directory']).read()
result['identity']=next(row['data'] for row in records if row['event']=='identity-intent')
result['cleanupEvent']=records[-1]['event']
print(${JSON.stringify(fixtureReceiptPrefix)}+json.dumps(result),file=sys.stderr,flush=True)
`;
  const group = createScenarioProcessGroup(true);
  const captured = await runFifoProcess({
    command: "sudo",
    args: [
      "-n",
      "/usr/bin/python3",
      "-B",
      "-I",
      "-S",
      "-c",
      driver,
      script,
      argumentsJson,
      supervisor,
      sentinelPath ?? "",
      forceReadyPath ?? "",
    ],
    cwd: repoRoot,
    env: { PATH: process.env.PATH },
    timeoutMs: kernelFixtureTimeoutMs,
    stdoutLimitBytes: 1024 * 1024,
    stderrLimitBytes: 1024 * 1024,
    signalGroup: group.signal,
    terminateGroup: group.terminate,
  });
  if (captured.code !== 0)
    throw new Error(`Kernel fixture controller failed: ${captured.stderr}`);
  const lines = captured.stderr.split("\n");
  const receipts = lines.filter((line) =>
    line.startsWith(fixtureReceiptPrefix),
  );
  const [receiptLine] = receipts;
  if (receipts.length !== 1 || typeof receiptLine !== "string")
    throw new Error("Kernel fixture omitted its unique terminal receipt");
  const receipt: unknown = JSON.parse(
    receiptLine.slice(fixtureReceiptPrefix.length),
  );
  if (!receipt || typeof receipt !== "object" || !("directory" in receipt)) {
    throw new Error("Kernel fixture omitted its terminal lifecycle result");
  }
  let lifecycleCode: number;
  if (forceReadyPath) {
    if (
      !("controllerSignal" in receipt) ||
      receipt.controllerSignal !== "SIGTERM" ||
      !("nativeLedgerQualified" in receipt) ||
      receipt.nativeLedgerQualified !== false
    ) {
      throw new Error(
        "Forced fixture omitted actual controller death evidence",
      );
    }
    lifecycleCode = 128 + 15;
  } else {
    if (!("terminal" in receipt))
      throw new Error("Kernel fixture omitted its terminal");
    const terminal = receipt.terminal;
    if (
      !terminal ||
      typeof terminal !== "object" ||
      !("nativeLedgerQualified" in terminal) ||
      terminal.nativeLedgerQualified !== false ||
      !("lifecycleCode" in terminal) ||
      typeof terminal.lifecycleCode !== "number" ||
      !Number.isSafeInteger(terminal.lifecycleCode)
    )
      throw new Error(
        "Kernel fixture returned an invalid unsigned lifecycle result",
      );
    lifecycleCode = terminal.lifecycleCode;
  }
  if (
    !("identity" in receipt) ||
    !receipt.identity ||
    typeof receipt.identity !== "object" ||
    !("uid" in receipt.identity) ||
    typeof receipt.identity.uid !== "number" ||
    !Number.isSafeInteger(receipt.identity.uid) ||
    receipt.identity.uid <= 0 ||
    !("cleanupEvent" in receipt) ||
    receipt.cleanupEvent !== "cleanup-verified"
  ) {
    throw new Error(
      "Kernel fixture omitted its owned identity or verified cleanup",
    );
  }
  kernelFixtureUnproven = false;
  return {
    ...captured,
    code: lifecycleCode,
    hostUid: receipt.identity.uid,
    stderr: lines
      .filter((line) => !line.startsWith(fixtureReceiptPrefix))
      .join("\n")
      .trim(),
    receipt,
  };
}

/** Uses admitted FIFO streams for root setup probes under the same descriptor barrier. */
async function runSetupProbe(args: string[], timeoutMs = 30_000) {
  const group = createScenarioProcessGroup(true);
  const result = await runFifoProcess({
    command: "sudo",
    args,
    cwd: repoRoot,
    env: { PATH: process.env.PATH },
    timeoutMs,
    stdoutLimitBytes: 1024 * 1024,
    stderrLimitBytes: 1024 * 1024,
    signalGroup: group.signal,
    terminateGroup: group.terminate,
  });
  return { ...result, status: result.code };
}

/** Real host endpoints distinguish denied egress from an unreachable destination. */
async function startOwnedNetworkProbes() {
  const host = Object.values(networkInterfaces())
    .flat()
    .find(
      (address) => address?.family === "IPv4" && !address.internal,
    )?.address;
  if (!host)
    throw new Error(
      "Containment proof requires an owned non-loopback IPv4 interface",
    );
  const arrivals = { tcp: 0, udp: 0, dns: 0 };
  const tcp = createServer((socket) => {
    arrivals.tcp++;
    socket.end("owned-network-probe");
  });
  const udp = createSocket("udp4");
  const dns = createSocket("udp4");
  const bound = new Set<"tcp" | "udp" | "dns">();
  const close = async () => {
    await Promise.all([
      ...(bound.has("tcp")
        ? [
            new Promise<void>((resolve, reject) =>
              tcp.close((error) => (error ? reject(error) : resolve())),
            ),
          ]
        : []),
      ...(bound.has("udp")
        ? [new Promise<void>((resolve) => udp.close(resolve))]
        : []),
      ...(bound.has("dns")
        ? [new Promise<void>((resolve) => dns.close(resolve))]
        : []),
    ]);
  };
  for (const [name, socket] of [
    ["udp", udp],
    ["dns", dns],
  ] as const) {
    socket.on("message", (message, remote) => {
      arrivals[name]++;
      socket.send(message, remote.port, remote.address);
    });
  }
  try {
    const readiness = [
      once(tcp, "listening").then(() => bound.add("tcp")),
      once(udp, "listening").then(() => bound.add("udp")),
      once(dns, "listening").then(() => bound.add("dns")),
    ];
    tcp.listen(0, host);
    udp.bind(0, host);
    dns.bind(0, host);
    const starts = await Promise.allSettled(readiness);
    for (const result of starts)
      if (result.status === "rejected") throw result.reason;
    const address = tcp.address();
    if (!address || typeof address === "string")
      throw new Error("Owned TCP listener did not bind");
    const client = createConnection({ host, port: address.port });
    const response = once(client, "data", {
      signal: AbortSignal.timeout(2_000),
    });
    try {
      await response;
    } finally {
      client.destroy();
    }
    for (const socket of [udp, dns]) {
      const probe = createSocket("udp4");
      const reply = once(probe, "message", {
        signal: AbortSignal.timeout(2_000),
      });
      try {
        probe.send(Buffer.from("owned-readiness"), socket.address().port, host);
        await reply;
      } finally {
        probe.close();
      }
    }
    return {
      host,
      tcpPort: address.port,
      udpPort: udp.address().port,
      // A DNS wire query targets an owned ephemeral listener; UDP denial is independent of destination port.
      dnsPort: dns.address().port,
      arrivals,
      baseline: { ...arrivals },
      close,
    };
  } catch (error) {
    // error-policy:J2 Preserve readiness failure after closing this test's listeners.
    try {
      await close();
    } catch (cleanupError) {
      // error-policy:J2 Retain both setup and owned-listener teardown failures.
      throw new AggregateError(
        [error, cleanupError],
        "Owned network fixture setup and cleanup failed",
      );
    }
    throw error;
  }
}

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

test("sandbox launch fails closed when host authority is unavailable", async () => {
  const createLaunch = () =>
    sandboxCommand({
      enabled: true,
      allowedPorts: "4311",
      repoRoot,
      outputDir: "/output",
      environmentPath: "/output/.sandbox-environment-test.bin",
      callerHome: "/home/caller",
      callerUid: 1000,
      runtime: "/runtime",
      args: [],
    });
  if (process.platform !== "linux") {
    expect(createLaunch).toThrow("Sandbox supervisor identity requires Linux");
    return;
  }
  const launch = createLaunch();
  const child = spawn(launch.command, launch.args, {
    env: { PATH: "/definitely-no-sudo" },
    stdio: "ignore",
  });
  const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
    child.once("error", resolve);
  });
  expect(error.code).toBe("ENOENT");
});

for (const platform of ["darwin", "linux"]) {
  for (const mode of ["real-llm", "deterministic-mock"]) {
    for (const flag of [undefined, "0", "1"]) {
      test(`admission ${platform} ${mode} ${flag ?? "unset"} preserves its launch boundary`, () => {
        const child = spawnSync(
          process.execPath,
          [
            "--conditions=eliza-source",
            "-e",
            `
        import { linuxSandboxEnabled, sandboxCommand } from ${JSON.stringify(path.join(import.meta.dirname, "linux-sandbox.ts"))};
        import { spawnSync } from "node:child_process";
        Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
        const enabled = linuxSandboxEnabled(${JSON.stringify(mode)});
        if (enabled) process.stdout.write("boundary-required");
        else {
          const launch = sandboxCommand({ enabled, runtime: process.execPath,
            args: ["-e", "process.stdout.write('uncontained-launch')"] });
          const child = spawnSync(launch.command, launch.args, { encoding: "utf8" });
          process.stdout.write(child.stdout);
        }
      `,
          ],
          {
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              ...(flag === undefined
                ? {}
                : { ELIZA_STABILITY_LINUX_SANDBOX: flag }),
            },
          },
        );
        if (platform === "linux" && flag === "1") {
          expect(child.status).toBe(0);
          expect(child.stdout).toBe("boundary-required");
        } else if (mode === "deterministic-mock" && flag === undefined) {
          expect(child.status).toBe(0);
          expect(child.stdout).toBe("uncontained-launch");
        } else {
          expect(child.status).not.toBe(0);
          expect(child.stdout).toBe("");
        }
      });
    }
  }
}

const hostedLinux =
  process.platform === "linux" &&
  process.env.ELIZA_STABILITY_LINUX_SANDBOX === "1";

test.skipIf(!hostedLinux)(
  "descriptor admission closes inherited sockets before exec and rejects invalid handles",
  () => {
    const result = spawnSync(
      "sudo",
      [
        "-n",
        "/usr/bin/python3",
        "-I",
        "-S",
        path.join(
          repoRoot,
          "packages/cloud/e2e/scripts/stability-sandbox-exec.test.py",
        ),
      ],
      { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
  65_000,
);

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
    let cleanupVerified = false;
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
    const ownedNetwork = await startOwnedNetworkProbes();
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
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
let nativeProbeSequence = 0;
const runNative = (command, args) => new Promise((resolve, reject) => {
  const prefix = import.meta.dir + "/native-probe-" + (++nativeProbeSequence);
  const stdoutFd = openSync(prefix + ".stdout", "w", 0o600);
  const stderrFd = openSync(prefix + ".stderr", "w", 0o600);
  let child;
  try {
    child = spawn(command, args, { stdio: ["ignore", stdoutFd, stderrFd] });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  child.once("error", reject);
  child.once("close", (status, signal) => resolve({
    status, signal,
    stdout: readFileSync(prefix + ".stdout", "utf8"),
    stderr: readFileSync(prefix + ".stderr", "utf8"),
  }));
});
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
const udp = (family, host, port, payload = Buffer.from("escape")) => new Promise((resolve) => {
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
    socket.send(payload, (error) => {
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
const syscallProbe = await runNative("/usr/bin/python3", ["-c", syscallPython]);
const syscallResult = syscallProbe.status === 0
  ? JSON.parse(syscallProbe.stdout)
  : { probeError: syscallProbe.stderr, error: syscallProbe.error?.message, signal: syscallProbe.signal };
let procReadable = false;
try { readFileSync("/proc/" + process.env.PROBE_PARENT_PID + "/environ"); procReadable = true; } catch {}
let fdSecretReadable = false;
try { if (fstatSync(3).isFile()) fdSecretReadable = readFileSync(3, "utf8").includes("fd-secret"); } catch {}
let hostTmpReadable = false;
try { hostTmpReadable = readFileSync(process.env.PROBE_HOST_TMP_PATH, "utf8") === "must-be-masked"; } catch {}
const rawProbeAvailable = (await runNative("/usr/bin/python3", ["--version"])).status === 0;
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
  externalTcp: await tcp(process.env.PROBE_OWNED_HOST, Number(process.env.PROBE_OWNED_TCP_PORT)),
  externalUdp: await udp("udp4", process.env.PROBE_OWNED_HOST, Number(process.env.PROBE_OWNED_UDP_PORT)),
  dnsUdp: await udp("udp4", process.env.PROBE_OWNED_HOST, Number(process.env.PROBE_OWNED_DNS_PORT), Buffer.from("123401000001000000000000056f776e656407696e76616c69640000010001", "hex")),
  ipv6Udp: await udp("udp6", "::1", Number(process.env.PROBE_BLOCKED_IPV6_PORT)),
  rawProbeAvailable,
  rawIpv4: (await runNative("/usr/bin/python3", ["-c", "import socket; socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)"])).status === 0,
  rawIpv6: (await runNative("/usr/bin/python3", ["-c", "import socket; socket.socket(socket.AF_INET6, socket.SOCK_RAW, socket.IPPROTO_RAW)"])).status === 0,
  filesystemUnix: await unix(process.env.PROBE_FILESYSTEM_UNIX),
  abstractUnix: await unix("\\0" + process.env.PROBE_ABSTRACT_UNIX_NAME),
  syscallResult,
}));
`,
        // Executable input is readable within the private attempt directory.
        { mode: 0o444 },
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
            PROBE_OWNED_HOST: ownedNetwork.host,
            PROBE_OWNED_TCP_PORT: String(ownedNetwork.tcpPort),
            PROBE_OWNED_UDP_PORT: String(ownedNetwork.udpPort),
            PROBE_OWNED_DNS_PORT: String(ownedNetwork.dnsPort),
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
      let captured: Awaited<ReturnType<typeof runKernelFixture>>;
      try {
        captured = await runKernelFixture(launch, sentinelPath);
        cleanupVerified = true;
      } finally {
        await rm(sentinelDirectory, { recursive: true, force: true });
      }
      const { stdout, stderr, code } = captured;
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(ownedNetwork.arrivals).toEqual(ownedNetwork.baseline);
      const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
      expect(result.uid).toBe(0);
      expect(result.hostUid).not.toBe(process.getuid?.());
      expect(result.hostUid).toBe(captured.hostUid);
      const { uid: _uid, hostUid: _hostUid, ...observed } = result;
      expect(observed).toEqual({
        secretPresent: false,
        procReadable: false,
        fdSecretReadable: false,
        hostTmpReadable: false,
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
      const missingBwrap = await runSetupProbe(
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
        30_000,
      );
      expect(missingBwrap.status).not.toBe(0);
      expect(missingBwrap.stderr).toContain("missing required command: bwrap");
      const missingIptables = await runSetupProbe(
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
          realpathSync("/usr/sbin/iptables"),
          "/bin/bash",
          setupScript,
          "setup",
        ],
        30_000,
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
      await ownedNetwork.close();
      datagramServer.kill("SIGKILL");
      await rm(hostTmpDirectory, { recursive: true, force: true });
      expectAclRestored(directory, attemptAcl);
      expectAclRestored(outputRoot, outputRootAcl);
      if (cleanupVerified)
        await rm(outputRoot, { recursive: true, force: true });
    }
  },
  kernelFixtureTimeoutMs + 30_000,
);

test.skipIf(!hostedLinux)(
  "early bwrap failure removes the sandbox identity and kernel state",
  async () => {
    let cleanupVerified = false;
    const {
      attempt: directory,
      attemptAcl,
      outputRoot,
      outputRootAcl,
    } = await createPrivateAttempt("cloud-sandbox-early-failure-");
    const fixtureRoot = await mkdtemp(
      path.join(tmpdir(), "cloud-bwrap-failure-launcher-"),
    );
    try {
      const fakeBwrapPath = path.join(fixtureRoot, "failing-bwrap");
      await writeFile(fakeBwrapPath, "#!/bin/sh\nexit 91\n", { mode: 0o755 });
      const scripts = path.join(repoRoot, "packages/cloud/e2e/scripts");
      for (const name of [
        "stability-sandbox-owner.py",
        "stability-sandbox-identity.py",
        "stability-sandbox-exec.py",
        "stability-native-attestation.py",
      ]) {
        await copyFile(path.join(scripts, name), path.join(fixtureRoot, name));
      }
      const original = await readFile(
        path.join(scripts, "stability-linux-sandbox.sh"),
        "utf8",
      );
      const invocation = "/usr/bin/bwrap --die-with-parent";
      if (
        original.split(invocation).length !== 2 ||
        !/^\/[A-Za-z0-9_./-]+$/.test(fakeBwrapPath)
      ) {
        throw new Error(
          "Owned external-command failure injection does not match the launcher",
        );
      }
      // The guardian creates its own systemd namespace; an outer mount cannot inject its bwrap failure.
      // Only this fixture copy replaces that external command. Identity, firewall and cleanup code stay real.
      const fixtureScript = path.join(
        fixtureRoot,
        "stability-linux-sandbox.sh",
      );
      await writeFile(
        fixtureScript,
        original.replace(invocation, `${fakeBwrapPath} --die-with-parent`),
        { mode: 0o500 },
      );
      await chmod(fixtureRoot, 0o555);
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
      const runIndex = launch.args.indexOf("run");
      if (runIndex < 1)
        throw new Error("Production launcher did not identify its script");
      launch.args[runIndex - 1] = fixtureScript;
      const result = await runKernelFixture(launch);
      cleanupVerified = true;
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("unbound variable");
      if (result.code !== 91) {
        throw new Error(
          `Owned bwrap failure injection returned ${result.code}: ${result.stderr}`,
        );
      }
      expect(existsSync(environmentPath)).toBe(false);
      expect(
        spawnSync("pgrep", ["-u", String(result.hostUid)], { stdio: "ignore" })
          .status,
      ).toBe(1);
      expect(
        spawnSync("getent", ["passwd", String(result.hostUid)], {
          stdio: "ignore",
        }).status,
      ).toBe(2);
      const accessControl = spawnSync("getfacl", ["-R", directory], {
        encoding: "utf8",
      });
      expect(accessControl.status).toBe(0);
      expect(accessControl.stdout).not.toContain(`user:${result.hostUid}:`);
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
      if (cleanupVerified) {
        await chmod(fixtureRoot, 0o700);
        await rm(fixtureRoot, { recursive: true, force: true });
      }
      if (cleanupVerified)
        await rm(outputRoot, { recursive: true, force: true });
    }
  },
  kernelFixtureTimeoutMs + 30_000,
);

test.skipIf(!hostedLinux)(
  "forced teardown kills signal-resistant descendants and removes kernel state",
  async () => {
    let cleanupVerified = false;
    const {
      attempt: directory,
      attemptAcl,
      outputRoot,
      outputRootAcl,
    } = await createPrivateAttempt("cloud-sandbox-teardown-");
    const readyPath = path.join(directory, "ready.json");
    const probePath = path.join(directory, "teardown-probe.ts");
    try {
      await writeFile(
        probePath,
        `
import { spawn } from "node:child_process";
import { writeFileSync, renameSync, existsSync, openSync, closeSync, fstatSync, readFileSync, constants } from "node:fs";
const childReady = process.env.TEARDOWN_READY_PATH + ".descendant";
const descendant = spawn(process.execPath, ["-e", \`
import * as fs from 'node:fs';
process.on('SIGTERM', () => {});
const fields = fs.readFileSync('/proc/self/stat','utf8').split(') ').at(-1).split(' ');
if (Number(fields[3]) !== process.pid) throw new Error('descendant did not enter its own session');
const target = process.env.TEARDOWN_READY_PATH + '.descendant';
fs.writeFileSync(target + '.pending', JSON.stringify({ pid: process.pid, uid: process.getuid(), sessionId: Number(fields[3]) }), { flag: 'wx', mode: 0o400 });
fs.renameSync(target + '.pending', target);
setInterval(() => {}, 1000);
\`], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
process.on("SIGTERM", () => {});
let childError;
descendant.once('error', error => { childError = error; });
const deadline = performance.now() + 10000;
while (!existsSync(childReady)) {
  if (childError) throw childError;
  if (descendant.exitCode !== null || performance.now() >= deadline) throw new Error('owned descendant readiness failed');
  await new Promise(resolve => setTimeout(resolve, 10));
}
const readyFd = openSync(childReady, constants.O_RDONLY | constants.O_NOFOLLOW);
try {
  const metadata = fstatSync(readyFd);
  if (!metadata.isFile() || metadata.uid !== process.getuid() || metadata.nlink !== 1 || metadata.size > 1024) throw new Error('invalid descendant readiness authority');
  const identity = JSON.parse(readFileSync(readyFd, 'utf8'));
  if (identity.pid !== descendant.pid || identity.uid !== process.getuid() || identity.sessionId !== descendant.pid) throw new Error('descendant readiness identity changed');
} finally { closeSync(readyFd); }
writeFileSync(process.env.TEARDOWN_READY_PATH + ".pending", JSON.stringify({
  uid: process.getuid?.(),
  hostUid: Number(process.env.ELIZA_STABILITY_SANDBOX_HOST_UID),
  pid: process.pid,
  descendantPid: descendant.pid,
}));
renameSync(process.env.TEARDOWN_READY_PATH + ".pending", process.env.TEARDOWN_READY_PATH);
setInterval(() => {}, 1000);
`,
        // Executable input is readable within the private attempt directory.
        { mode: 0o444 },
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
      const captured = await runKernelFixture(launch, undefined, readyPath);
      cleanupVerified = true;
      const ready: {
        uid: number;
        hostUid: number;
        pid: number;
        descendantPid: number;
      } = JSON.parse(await readFile(readyPath, "utf8"));
      expect(ready.uid).toBe(0);
      expect(ready.hostUid).toBe(captured.hostUid);
      expect(captured.code).toBe(143);
      expect(
        spawnSync("pgrep", ["-u", String(ready.hostUid)], {
          stdio: "ignore",
          timeout: 5_000,
        }).status,
      ).toBe(1);
      expect(
        spawnSync("getent", ["passwd", String(ready.hostUid)], {
          stdio: "ignore",
          timeout: 5_000,
        }).status,
      ).toBe(2);
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
      expectAclRestored(directory, attemptAcl);
      expectAclRestored(outputRoot, outputRootAcl);
      if (cleanupVerified)
        await rm(outputRoot, { recursive: true, force: true });
    }
  },
  kernelFixtureTimeoutMs + 30_000,
);

test.skipIf(!hostedLinux)(
  "capability admission exercises the real guardian-backed launcher",
  () => {
    if (kernelFixtureUnproven)
      throw new Error(
        "Prior kernel fixture cleanup is unproven; refusing capability allocation",
      );
    kernelFixtureUnproven = true;
    assertLinuxSandboxCapabilities(
      repoRoot,
      "deterministic-mock",
      path.join(
        repoRoot,
        "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
      ),
    );
    kernelFixtureUnproven = false;
  },
  kernelFixtureTimeoutMs + 30_000,
);

test.skipIf(!hostedLinux)(
  "capability admission rejects unavailable guardian firewall authority",
  async () => {
    const setupScript = path.join(
      repoRoot,
      "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
    );
    if (kernelFixtureUnproven)
      throw new Error(
        "Prior kernel fixture cleanup is unproven; refusing capability allocation",
      );
    kernelFixtureUnproven = true;
    const denied = await runSetupProbe(
      [
        "-n",
        "/usr/bin/python3",
        "-I",
        "-S",
        path.join(
          repoRoot,
          "packages/cloud/e2e/scripts/stability-sandbox-capability.test.py",
        ),
        path.dirname(setupScript),
      ],
      3 * NATIVE_STABILITY_TIMEOUT_MS + 150_000,
    );
    // This helper passes only after an actual restricted guardian rejection and
    // separate full-authority recovery; it never reports native qualification.
    expect(denied.status).toBe(0);
    const receipt: unknown = JSON.parse(denied.stdout);
    expect(receipt).toMatchObject({
      passed: true,
      nativeQualified: false,
      setupStatus: 1,
      cleanupErrors: [],
      fixtureRootAbsent: true,
    });
    kernelFixtureUnproven = false;
  },
  3 * NATIVE_STABILITY_TIMEOUT_MS + 180_000,
);
