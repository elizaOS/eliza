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
