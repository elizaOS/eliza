/** Explicit package interruption for a lease-owning disposable Android test runner. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  readAndroidProcessIdentity,
  requireAndroidInterruptionMarker,
  requireSameAndroidProcess,
} from "./android-process-identity.mjs";

export async function waitAndInterruptAndroidPackage({
  run,
  assertCustody,
  packageName,
  androidUser,
  runId,
  markerPath,
  timeoutMs = 300000,
  signal,
}) {
  assert.match(
    packageName ?? "",
    /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/,
  );
  assert.ok(Number.isSafeInteger(androidUser) && androidUser >= 0);
  assert.match(runId ?? "", /^[a-f0-9]{32}$/);
  assert.match(
    markerPath ?? "",
    /^files\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/,
  );
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000,
  );
  assert.equal(typeof assertCustody, "function");
  const deadline = performance.now() + timeoutMs;
  const check = () => {
    signal?.throwIfAborted();
    assert.ok(performance.now() < deadline, "Interruption deadline expired");
  };
  const command = async (...args) => {
    check();
    return run(...args);
  };
  const readMarker = async () => {
    const text = await command(
      "exec-out",
      "run-as",
      packageName,
      "--user",
      String(androidUser),
      "cat",
      markerPath,
    );
    assert.ok(
      typeof text === "string" && text.length <= 4096,
      "Invalid interruption marker size",
    );
    return JSON.parse(text);
  };
  await assertCustody();
  let marker = null;
  for (;;) {
    check();
    try {
      marker = await readMarker();
      break;
    } catch (error) {
      // Only a not-yet-created file is retryable; permission, malformed JSON and ADB errors fail.
      if (
        error.code !== 1 ||
        !/No such file or directory/.test(error.stderr ?? "")
      )
        throw error;
    }
    await delay(
      Math.min(100, Math.max(1, deadline - performance.now())),
      undefined,
      { signal },
    );
  }
  const identity = await readAndroidProcessIdentity({
    run: command,
    packageName,
    androidUser,
    pid: marker?.pid,
  });
  requireAndroidInterruptionMarker(marker, runId, identity);
  const exclusiveUid = async () => {
    const packages = (
      await command(
        "shell",
        "pm",
        "list",
        "packages",
        "--uid",
        String(identity.uid),
        "--user",
        String(androidUser),
      )
    )
      .trim()
      .split(/\r?\n/);
    assert.deepEqual(
      packages,
      [`package:${packageName}`],
      "App UID is shared with an unowned package",
    );
  };
  await exclusiveUid();
  const uidNames = new Set([
    String(identity.uid),
    `u${androidUser}_a${(identity.uid % 100000) - 10000}`,
  ]);
  const processes = async () => {
    const output = await command("shell", "ps", "-A", "-o", "UID,PID,NAME");
    const lines = output.trim().split(/\r?\n/);
    assert.match(lines.shift() ?? "", /^\s*UID\s+PID\s+NAME\s*$/);
    const owned = [];
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      assert.ok(
        fields.length === 3 && /^\d+$/.test(fields[1]),
        "Malformed process inventory",
      );
      if (uidNames.has(fields[0])) {
        const pid = Number(fields[1]);
        assert.ok(Number.isSafeInteger(pid) && pid > 1);
        owned.push({ pid, name: fields[2] });
      }
    }
    return owned;
  };
  const before = await processes();
  assert.ok(
    before.some(
      (item) => item.pid === identity.pid && item.name === packageName,
    ),
    "Main process absent from owned UID inventory",
  );
  await assertCustody();
  requireAndroidInterruptionMarker(await readMarker(), runId, identity);
  requireSameAndroidProcess(
    identity,
    await readAndroidProcessIdentity({
      run: command,
      packageName,
      androidUser,
      pid: identity.pid,
    }),
  );
  await exclusiveUid();
  await command(
    "shell",
    "am",
    "force-stop",
    "--user",
    String(androidUser),
    packageName,
  );
  for (;;) {
    const remaining = await processes();
    if (!remaining.length) break;
    await delay(
      Math.min(100, Math.max(1, deadline - performance.now())),
      undefined,
      { signal },
    );
  }
  await assertCustody();
  check();
  return {
    interrupted: true,
    mechanism: "am-force-stop",
    runId,
    identity,
    terminatedPids: before.map((item) => item.pid),
    uidProcessesAfter: 0,
  };
}
