/** Process identity evidence for owned, disposable Android acceptance fixtures. */
import assert from "node:assert/strict";

const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function androidProcessIdentity({
  packageName,
  androidUser,
  expectedUid,
  pid,
  status,
  stat,
  cmdline,
}) {
  assert.match(packageName ?? "", packagePattern);
  assert.ok(Number.isSafeInteger(androidUser) && androidUser >= 0);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  for (const text of [status, stat, cmdline])
    assert.ok(
      typeof text === "string" && text.length > 0 && text.length <= 65536,
    );
  const uids = [
    ...status.matchAll(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/gm),
  ];
  assert.equal(uids.length, 1, "Missing or ambiguous process UID");
  const values = uids[0].slice(1).map(Number);
  assert.ok(
    values.every((value) => Number.isSafeInteger(value) && value === values[0]),
    "Process UID changed privilege",
  );
  const uid = values[0];
  assert.ok(Number.isSafeInteger(expectedUid));
  assert.equal(
    uid,
    expectedUid,
    "Process does not belong to the installed package UID",
  );
  assert.equal(Math.floor(uid / 100000), androidUser, "Wrong Android user");
  assert.ok(
    uid % 100000 >= 10000 && uid % 100000 <= 19999,
    "Expected an ordinary app UID",
  );
  assert.equal(
    cmdline,
    `${packageName}\0`,
    "Process is not the owned main application",
  );
  // comm may contain spaces and parentheses; fields after the last ')' start at state (3).
  const end = stat.lastIndexOf(")");
  assert.ok(
    end > 0 && stat.startsWith(`${pid} (`),
    "Wrong process stat identity",
  );
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  assert.ok(
    fields.length >= 20 && /^[RSDTtIP]$/.test(fields[0]),
    "Process is dead or malformed",
  );
  const startTimeTicks = fields[19];
  assert.match(startTimeTicks, /^[1-9]\d*$/);
  return Object.freeze({ packageName, androidUser, pid, uid, startTimeTicks });
}

export function requireSameAndroidProcess(expected, current) {
  assert.deepEqual(current, expected, "Owned application process was replaced");
}

export function requireAndroidInterruptionMarker(marker, runId, identity) {
  assert.match(runId ?? "", /^[a-f0-9]{32}$/);
  assert.ok(marker && typeof marker === "object" && !Array.isArray(marker));
  assert.equal(marker.runId, runId, "Stale interruption marker");
  assert.equal(marker.pid, identity.pid, "Marker belongs to another process");
  assert.equal(
    marker.startTimeTicks,
    identity.startTimeTicks,
    "Marker belongs to a replaced process",
  );
}

/** Read only through the selected debuggable package; callers retain lease/APK custody. */
export async function readAndroidProcessIdentity({
  run,
  packageName,
  androidUser,
  pid,
}) {
  assert.match(packageName ?? "", packagePattern);
  assert.ok(Number.isSafeInteger(androidUser) && androidUser >= 0);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const read = (...args) =>
    run(
      "exec-out",
      "run-as",
      packageName,
      "--user",
      String(androidUser),
      ...args,
    );
  const uidText = (await read("id", "-u")).trim();
  assert.match(uidText, /^[1-9]\d*$/);
  const expectedUid = Number(uidText);
  const stat = await read("cat", `/proc/${pid}/stat`);
  const status = await read("cat", `/proc/${pid}/status`);
  const cmdline = await read("cat", `/proc/${pid}/cmdline`);
  const input = {
    packageName,
    androidUser,
    expectedUid,
    pid,
    status,
    stat,
    cmdline,
  };
  const identity = androidProcessIdentity(input);
  requireSameAndroidProcess(
    identity,
    androidProcessIdentity({
      ...input,
      stat: await read("cat", `/proc/${pid}/stat`),
    }),
  );
  assert.equal(
    (await read("id", "-u")).trim(),
    uidText,
    "Installed package UID changed during observation",
  );
  return identity;
}
