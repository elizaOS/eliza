/**
 * Exercises the real Linux FIFO caller with owned Python processes and groups.
 * Output, decoding, admission, cancellation and retained writers cross actual
 * kernel descriptors; no network data or provider credentials are used.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type FifoProcessOptions, runFifoProcess } from "./fifo-process.ts";
import {
  createScenarioProcessGroup,
  runBoundedProcessControl,
  runProcessControlBeforeDeadline,
  terminateScenarioProcessGroup,
} from "./scenario-process-group.ts";

const groups = createScenarioProcessGroup(false);
const signalGroup = groups.signal;
const terminateGroup = groups.terminate;
function options(code: string): FifoProcessOptions {
  return {
    command: "/usr/bin/python3",
    args: ["-I", "-S", "-c", code],
    cwd: process.cwd(),
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 10_000,
    stdoutLimitBytes: 1024 * 1024,
    stderrLimitBytes: 1024 * 1024,
    signalGroup,
    terminateGroup,
  };
}
const roots = () =>
  readdirSync(tmpdir())
    .filter((entry) => entry.startsWith("eliza-scenario-stdio-"))
    .sort();
const linux = { skip: process.platform !== "linux", timeout: 20_000 };

for (const [name, body] of [
  [
    "complete concurrent output and split UTF-8 survive FIFO capture",
    async () => {
      const result = await runFifoProcess(
        options(`import os,threading
assert all(__import__('stat').S_ISFIFO(os.fstat(fd).st_mode) for fd in (1,2))
def write(fd,byte):
 for i in range(256): os.write(fd,byte*1024)
 for byte in '🌍'.encode(): os.write(fd,bytes([byte]))
threads=[threading.Thread(target=write,args=(1,b'O')),threading.Thread(target=write,args=(2,b'E'))]
[t.start() for t in threads]
[t.join() for t in threads]`),
      );
      assert.equal(result.code, 0);
      assert.equal(result.stdout, `${"O".repeat(256 * 1024)}🌍`);
      assert.equal(result.stderr, `${"E".repeat(256 * 1024)}🌍`);
    },
  ],
  [
    "empty streams and final nonzero diagnostics remain complete",
    async () => {
      const empty = await runFifoProcess(options("pass"));
      assert.equal(empty.stdout, "");
      assert.equal(empty.stderr, "");
      const result = await runFifoProcess(
        options(
          "import os; os.write(1,b'final-out'); os.write(2,b'final-error'); os._exit(7)",
        ),
      );
      assert.equal(result.code, 7);
      assert.equal(result.stdout, "final-out");
      assert.equal(result.stderr, "final-error");
    },
  ],
  [
    "missing executable rejects and removes prepared descriptors",
    async () => {
      await assert.rejects(
        runFifoProcess({
          ...options("pass"),
          command: "/definitely-absent-owned-program",
        }),
        { code: "STABILITY_CAPTURE_SPAWN" },
      );
    },
  ],
  [
    "size termination cannot become zero-exit success",
    async () => {
      await assert.rejects(
        runFifoProcess({
          ...options("import os; os.write(1,b'x'*4096); os._exit(0)"),
          stdoutLimitBytes: 16,
        }),
        { code: "STABILITY_CAPTURE_SIZE" },
      );
    },
  ],
  [
    "invalid complete UTF-8 is an explicit capture failure",
    async () => {
      await assert.rejects(
        runFifoProcess(options("import os; os.write(1,b'\\xff'); os._exit(0)")),
        { code: "STABILITY_CAPTURE_READ" },
      );
    },
  ],
  [
    "truncated UTF-8 at EOF fails instead of returning replacement text",
    async () => {
      await assert.rejects(
        runFifoProcess(
          options("import os; os.write(1,b'\\xf0\\x9f'); os._exit(0)"),
        ),
        { code: "STABILITY_CAPTURE_READ" },
      );
    },
  ],
  [
    "primary decoding failure remains in cleanup error cause",
    async () => {
      const cleanup = new Error("owned cleanup boundary failure");
      await assert.rejects(
        runFifoProcess({
          ...options("import os; os.write(1,b'\\xff')"),
          terminateGroup: async (pid) => {
            await terminateGroup(pid);
            throw cleanup;
          },
        }),
        (error: unknown) => {
          assert.ok(
            error instanceof Error &&
              "code" in error &&
              error.code === "STABILITY_CAPTURE_CLEANUP",
          );
          assert.ok(error.cause instanceof AggregateError);
          assert.equal(error.cause.errors[0].code, "STABILITY_CAPTURE_READ");
          assert.ok(error.cause.errors.includes(cleanup));
          return true;
        },
      );
    },
  ],
  [
    "bounded process-control timeout cannot mean absent group",
    async () => {
      assert.throws(
        () =>
          runBoundedProcessControl(
            "/usr/bin/python3",
            ["-I", "-S", "-c", "import time; time.sleep(60)"],
            100,
          ),
        { code: "STABILITY_PROCESS_CONTROL_FAILED" },
      );
      assert.throws(
        () => runBoundedProcessControl("/definitely-missing-owned-control", []),
        { code: "STABILITY_PROCESS_CONTROL_FAILED" },
      );
    },
  ],
  [
    "delayed control commands consume one remaining phase deadline",
    async () => {
      const started = performance.now();
      const deadline = started + 2000;
      const command = ["-I", "-S", "-c", "import time; time.sleep(1.1)"];
      assert.equal(
        runProcessControlBeforeDeadline("/usr/bin/python3", command, deadline),
        0,
      );
      assert.throws(
        () =>
          runProcessControlBeforeDeadline(
            "/usr/bin/python3",
            command,
            deadline,
          ),
        { code: "STABILITY_PROCESS_CONTROL_FAILED" },
      );
      assert.ok(
        performance.now() - started < 3000,
        "second command received a fresh phase budget",
      );
      assert.throws(
        () =>
          runProcessControlBeforeDeadline(
            "/usr/bin/python3",
            command,
            deadline,
          ),
        { code: "STABILITY_PROCESS_CONTROL_DEADLINE" },
      );
    },
  ],
  [
    "initial TERM transport timeout still kills the actual owned group",
    async () => {
      const child = spawn(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-c",
          "import time; print('READY',flush=True); time.sleep(60)",
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      const pid = child.pid!;
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout!.once("data", () => resolve());
          child.once("error", reject);
        });
        let killed = false;
        const started = performance.now();
        await terminateScenarioProcessGroup(pid, (id, signal, deadline) => {
          if (signal === "SIGTERM")
            return (
              runProcessControlBeforeDeadline(
                "/usr/bin/python3",
                ["-I", "-S", "-c", "import time; time.sleep(60)"],
                deadline,
              ) === 0
            );
          if (signal === "SIGKILL") killed = true;
          try {
            process.kill(-id, signal === "probe" ? 0 : signal);
            return true;
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            )
              return false;
            throw error;
          }
        });
        await exited;
        assert.equal(killed, true);
        assert.equal(groups.exists(pid), false);
        assert.ok(performance.now() - started < 10_000);
      } finally {
        if (groups.exists(pid)) process.kill(-pid, "SIGKILL");
        await exited;
      }
      const denied = new Error("owned transport permission denied");
      await assert.rejects(
        terminateScenarioProcessGroup(123, () => {
          throw denied;
        }),
        (error) => error === denied,
      );
    },
  ],
  [
    "actual privileged control observes and tears down owned group",
    async () => {
      const privileged = createScenarioProcessGroup(true);
      const result = await runFifoProcess({
        ...options("print('privileged-control-complete')"),
        signalGroup: privileged.signal,
        terminateGroup: privileged.terminate,
      });
      assert.equal(result.stdout, "privileged-control-complete\n");
      assert.equal(result.code, 0);
    },
  ],
  [
    "deadline kills an owned signal-resistant child",
    async () => {
      const directory = mkdtempSync(
        path.join(tmpdir(), "owned-capture-ready-"),
      );
      const ready = path.join(directory, "ready");
      const began = Date.now();
      try {
        await assert.rejects(
          runFifoProcess({
            ...options(`import os,signal,time
ready=${JSON.stringify(ready)}
def record(label):
 with open(ready,'a') as out: out.write(label+' '+str(os.getpid())+'\\n')
signal.signal(signal.SIGTERM,lambda *args:record('TERM'))
record('READY')
while True: time.sleep(1)`),
            timeoutMs: 1000,
            signalGroup: createScenarioProcessGroup(true).signal,
            terminateGroup: createScenarioProcessGroup(true).terminate,
          }),
          { code: "STABILITY_CAPTURE_TIMEOUT" },
        );
        const records = readFileSync(ready, "utf8");
        assert.match(records, /^READY \d+\nTERM \d+\n/);
        assert.ok(
          Date.now() - began >= 5000,
          "SIGKILL escalation was not exercised",
        );
        const pid = Number(records.split(" ")[1]?.split("\n")[0]);
        assert.equal(groups.exists(pid), false);
      } finally {
        rmSync(directory, { recursive: true });
      }
    },
  ],
  [
    "cancellation stops a running owned child",
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        await assert.rejects(
          runFifoProcess({
            ...options("import time; time.sleep(60)"),
            signal: controller.signal,
          }),
          { code: "STABILITY_CAPTURE_CANCELLED" },
        );
      } finally {
        clearTimeout(timer);
      }
    },
  ],
  [
    "group teardown releases a retained descendant writer before EOF",
    async () => {
      const result = await runFifoProcess(
        options(`import os,time,signal
pid=os.fork()
if pid==0:
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 time.sleep(60)
else:
 os.write(1,b'parent-complete')
 os._exit(0)`),
      );
      assert.equal(result.stdout, "parent-complete");
      assert.equal(result.code, 0);
    },
  ],
  [
    "actual descriptor barrier accepts FIFO caller streams",
    async () => {
      const helper = path.resolve(
        import.meta.dirname,
        "../../scripts/stability-sandbox-exec.py",
      );
      const result = await runFifoProcess(
        options(`import os,sys,tempfile,socket,resource
with tempfile.TemporaryDirectory(prefix='owned-fifo-policy-') as root:
 policy=root+'/policy'
 open(policy,'wb').write(b'owned-policy')
 os.chmod(policy,0o400)
 left,right=socket.socketpair()
 soft,hard=resource.getrlimit(resource.RLIMIT_NOFILE)
 resource.setrlimit(resource.RLIMIT_NOFILE,(max(soft,4097),hard))
 os.dup2(left.fileno(),100); os.dup2(left.fileno(),4096)
 os.dup2(os.open(policy,os.O_RDONLY),3)
 resource.setrlimit(resource.RLIMIT_NOFILE,(1024,hard))
 pid=os.fork()
 if pid==0:
  os.execv('/usr/bin/python3',['/usr/bin/python3','-I','-S',${JSON.stringify(helper)},policy,'/usr/bin/python3','-I','-S','-c',"import os,stat,errno; assert all(stat.S_ISFIFO(os.fstat(fd).st_mode) for fd in (1,2)); assert os.fstat(3).st_size>0;\\nfor fd in (100,4096):\\n try: os.fstat(fd); raise AssertionError('inherited descriptor')\\n except OSError as e: assert e.errno==errno.EBADF\\nprint('barrier-accepted')"])
 status=os.waitpid(pid,0)[1]
 assert os.waitstatus_to_exitcode(status)==0`),
      );
      assert.equal(result.stdout, "barrier-accepted\n");
      assert.equal(result.code, 0);
    },
  ],
] as const) {
  test(name, linux, async () => {
    const before = roots();
    await body();
    assert.deepEqual(roots(), before, "owned FIFO directory leaked");
    for (const fd of readdirSync("/proc/self/fd")) {
      try {
        assert.ok(
          !readlinkSync(`/proc/self/fd/${fd}`).includes(
            "eliza-scenario-stdio-",
          ),
          "owned FIFO descriptor leaked",
        );
      } catch (error) {
        // error-policy:J3 Enumeration's transient descriptor has already closed.
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
    }
  });
}
