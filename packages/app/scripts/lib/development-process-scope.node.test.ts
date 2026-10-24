import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { createDevelopmentProcessScope } from "./development-process-scope.ts";

const idle = ["-e", "setInterval(()=>{},1000)"];

test("stop drains only owned children, is reentrant and rejects later launches", async () => {
  const other = spawn(process.execPath, idle, { stdio: "ignore" });
  const before = process.listenerCount("SIGTERM");
  const failures = [];
  const scope = createDevelopmentProcessScope({
    cwd: process.cwd(),
    drainWindowMs: 1000,
    onUnexpectedExit: (value) => failures.push(value),
  });
  try {
    const child = scope.launch(
      "owned",
      process.execPath,
      idle,
      process.env,
      "ignore",
    );
    await once(child, "spawn");
    let reentrant: ReturnType<typeof scope.stop> | undefined;
    scope.signal.addEventListener("abort", () => {
      reentrant = scope.stop();
    });
    const stopped = scope.stop();
    assert.equal(stopped, reentrant);
    assert.equal(stopped, scope.stop());
    await stopped;
    await scope.waitForClose(child);
    assert.equal(scope.signal.aborted, true);
    assert.equal(other.exitCode, null);
    assert.equal(other.signalCode, null);
    assert.throws(() =>
      scope.launch("late", process.execPath, idle, process.env),
    );
    assert.throws(() => scope.waitForClose(other));
    assert.deepEqual(failures, []);
  } finally {
    await scope.dispose();
    other.kill();
    await once(other, "close");
  }
  assert.equal(process.listenerCount("SIGTERM"), before);
});

test("unexpected exit stops siblings; completed close remains awaitable", async () => {
  const failures = [];
  const scope = createDevelopmentProcessScope({
    cwd: process.cwd(),
    drainWindowMs: 1000,
    onUnexpectedExit: (value) => failures.push(value),
  });
  try {
    const sibling = scope.launch(
      "sibling",
      process.execPath,
      idle,
      process.env,
      "ignore",
    );
    const child = scope.launch(
      "exits",
      process.execPath,
      ["-e", "process.exit(7)"],
      process.env,
      "ignore",
    );
    await scope.waitForClose(child);
    await scope.stop();
    await scope.waitForClose(sibling);
    await scope.waitForClose(child);
    assert.deepEqual(failures, [
      { name: "exits", code: 7, signal: null, spawnFailed: false },
    ]);
  } finally {
    await scope.dispose();
  }
});

test("spawn failure aborts pending readiness and drains previously launched children", async () => {
  const failures = [];
  const scope = createDevelopmentProcessScope({
    cwd: process.cwd(),
    drainWindowMs: 1000,
    onUnexpectedExit: (value) => failures.push(value),
  });
  try {
    const sibling = scope.launch(
      "sibling",
      process.execPath,
      idle,
      process.env,
      "ignore",
    );
    const failed = scope.launch(
      "missing",
      `${process.cwd()}/missing-development-executable`,
      [],
      process.env,
      "ignore",
    );
    await scope.waitForClose(failed);
    await scope.stop();
    await scope.waitForClose(sibling);
    assert.equal(scope.signal.aborted, true);
    assert.deepEqual(failures, [
      { name: "missing", code: null, signal: null, spawnFailed: true },
    ]);
  } finally {
    await scope.dispose();
  }
});

test("SIGTERM to a real host drains its owned child and removes listeners", async () => {
  const moduleUrl = new URL("./development-process-scope.ts", import.meta.url)
    .href;
  const script = `import {createDevelopmentProcessScope} from ${JSON.stringify(moduleUrl)};
    const before=process.listenerCount('SIGTERM');
    const scope=createDevelopmentProcessScope({cwd:process.cwd(),drainWindowMs:1000,onUnexpectedExit:()=>{process.exitCode=1;}});
    const child=scope.launch('child',process.execPath,['-e','setInterval(()=>{},1000)'],process.env,'ignore');
    child.once('spawn',()=>console.log('READY'));
    try{await scope.waitForClose(child);}finally{await scope.dispose();}
    if(process.listenerCount('SIGTERM')!==before)process.exitCode=2;`;
  const host = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const closed = once(host, "close");
    assert.ok(host.stdout);
    const [ready] = await once(host.stdout, "data");
    assert.match(String(ready), /READY/);
    host.kill("SIGTERM");
    const [code, signal] = await closed;
    assert.equal(code, 0);
    assert.equal(signal, null);
  } finally {
    if (host.exitCode === null && host.signalCode === null)
      host.kill("SIGKILL");
  }
});

// Process groups and the watchdog are POSIX only.
const posixOnly = {
  skip: process.platform === "win32" && "process groups are POSIX only",
};
const moduleUrl = new URL("./development-process-scope.ts", import.meta.url)
  .href;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const killIfAlive = (pid: number) => {
  if (alive(pid)) process.kill(pid, "SIGKILL");
};
const waitForDeath = async (pid: number, waitMs: number) => {
  const deadline = Date.now() + waitMs;
  while (alive(pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
};
// Runs `body` in a host that prints a JSON line, then kills the host with SIGKILL.
const killHostAfter = async (body: string) => {
  const host = spawn(process.execPath, ["--input-type=module", "-e", body], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  assert.ok(host.stdout);
  const [line] = await once(host.stdout, "data");
  host.kill("SIGKILL");
  await once(host, "close");
  return JSON.parse(String(line));
};

test(
  "orphanWatchdog stops a child whose host is killed with SIGKILL",
  posixOnly,
  async () => {
    const orphanAfterHostKill = (orphanWatchdog: boolean) =>
      killHostAfter(`import {createDevelopmentProcessScope} from ${JSON.stringify(moduleUrl)};
      const scope=createDevelopmentProcessScope({cwd:process.cwd(),drainWindowMs:1000,orphanWatchdog:${orphanWatchdog},onUnexpectedExit:()=>{}});
      const child=scope.launch('child',process.execPath,['-e','setInterval(()=>{},1000)'],process.env,'ignore');
      child.once('spawn',()=>console.log(child.pid));`);
    const watched: number = await orphanAfterHostKill(true);
    try {
      await waitForDeath(watched, 5000);
      assert.equal(alive(watched), false);
    } finally {
      killIfAlive(watched);
    }
    const unwatched: number = await orphanAfterHostKill(false);
    try {
      await waitForDeath(unwatched, 1000);
      assert.equal(alive(unwatched), true);
    } finally {
      killIfAlive(unwatched);
    }
  },
);

// Each group is a detached idle child of the host, so it outlives the host.
const groupsScript = (count: number, then: string) =>
  `import {spawn} from 'node:child_process';
  import {startOrphanWatchdog} from ${JSON.stringify(moduleUrl)};
  const groups=Array.from({length:${count}},()=>{const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});g.unref();return g.pid;});
  const watchdog=startOrphanWatchdog();
  for(const g of groups)watchdog.register(g);
  ${then}
  console.log(JSON.stringify({groups,watchdog:watchdog.pid}));`;

test(
  "orphan watchdog skips a group unregistered before the host dies",
  posixOnly,
  async () => {
    const { groups } = await killHostAfter(
      groupsScript(2, "watchdog.unregister(groups[1]);"),
    );
    try {
      // The registered group's death shows the watchdog has run.
      await waitForDeath(groups[0], 5000);
      assert.equal(alive(groups[0]), false);
      assert.equal(alive(groups[1]), true);
    } finally {
      for (const group of groups) killIfAlive(group);
    }
  },
);

test(
  "orphan watchdog release exits the helper without signalling",
  posixOnly,
  async () => {
    const { groups, watchdog } = await killHostAfter(
      groupsScript(1, "watchdog.release();"),
    );
    try {
      await waitForDeath(watchdog, 5000);
      assert.equal(alive(watchdog), false);
      assert.equal(alive(groups[0]), true);
    } finally {
      killIfAlive(watchdog);
      for (const group of groups) killIfAlive(group);
    }
  },
);
