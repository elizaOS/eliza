import assert from "node:assert/strict";
import { test } from "node:test";
import {
  androidProcessIdentity,
  readAndroidProcessIdentity,
  requireAndroidInterruptionMarker,
  requireSameAndroidProcess,
} from "./android-process-identity.mjs";

function sample(overrides = {}) {
  return {
    packageName: "ai.example.helper",
    androidUser: 0,
    expectedUid: 10123,
    pid: 312,
    status: "Name:\thelper\nUid:\t10123\t10123\t10123\t10123\n",
    stat: `312 (name with ) parentheses) S ${Array(18).fill("0").join(" ")} 45678 0 0\n`,
    cmdline: "ai.example.helper\0",
    ...overrides,
  };
}
test("process evidence binds Android user, app UID, PID and start time despite comm parentheses", () => {
  const identity = androidProcessIdentity(sample());
  assert.deepEqual(identity, {
    packageName: "ai.example.helper",
    androidUser: 0,
    pid: 312,
    uid: 10123,
    startTimeTicks: "45678",
  });
  assert.ok(Object.isFrozen(identity));
  requireSameAndroidProcess(identity, androidProcessIdentity(sample()));
  requireAndroidInterruptionMarker(
    { runId: "a".repeat(32), pid: 312, startTimeTicks: "45678" },
    "a".repeat(32),
    identity,
  );
  assert.equal(
    androidProcessIdentity(
      sample({
        androidUser: 10,
        expectedUid: 1010123,
        status: "Uid:\t1010123\t1010123\t1010123\t1010123\n",
      }),
    ).androidUser,
    10,
  );
});
test("foreign, privileged, isolated, ambiguous and dead process evidence is rejected", () => {
  for (const change of [
    { pid: 1 },
    { expectedUid: 10124 },
    { pid: 313 },
    { androidUser: 1 },
    { cmdline: "ai.example.helper:child\0" },
    { cmdline: "ai.other.app\0" },
    { cmdline: "ai.example.helper\0argument\0" },
    { status: "Uid: 1000 1000 1000 1000\n" },
    { status: "Uid: 99000 99000 99000 99000\n" },
    { status: "Uid: 10123 0 10123 10123\n" },
    { status: "Uid: 10123 10123 10123 10123\nUid: 10123 10123 10123 10123\n" },
    { stat: sample().stat.replace(") S ", ") Z ") },
    { stat: sample().stat.replace(") S ", ") X ") },
    { stat: sample().stat.replace("45678", "0") },
  ])
    assert.throws(() => androidProcessIdentity(sample(change)));
});
test("PID reuse and stale or forged ready markers never authorize interruption", () => {
  const identity = androidProcessIdentity(sample());
  assert.throws(() =>
    requireSameAndroidProcess(identity, {
      ...identity,
      startTimeTicks: "45679",
    }),
  );
  assert.throws(() =>
    requireSameAndroidProcess(identity, { ...identity, uid: 10124 }),
  );
  const marker = { runId: "a".repeat(32), pid: 312, startTimeTicks: "45678" };
  for (const change of [
    { runId: "b".repeat(32) },
    { pid: 313 },
    { startTimeTicks: "45679" },
    { startTimeTicks: 45678 },
  ])
    assert.throws(() =>
      requireAndroidInterruptionMarker(
        { ...marker, ...change },
        marker.runId,
        identity,
      ),
    );
});

test("package-scoped reads verify UID and process start on both sides of observation", async () => {
  const input = sample();
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    assert.deepEqual(args.slice(0, 5), [
      "exec-out",
      "run-as",
      input.packageName,
      "--user",
      "0",
    ]);
    if (args[5] === "id") return "10123\n";
    return input[args[6].split("/").at(-1)];
  };
  const identity = await readAndroidProcessIdentity({ ...input, run });
  assert.equal(identity.pid, 312);
  assert.equal(
    calls.filter((args) => args.at(-1) === "/proc/312/stat").length,
    2,
  );
  for (const target of ["stat", "uid"]) {
    let count = 0;
    await assert.rejects(
      readAndroidProcessIdentity({
        ...input,
        run: async (...args) => {
          const value = await run(...args);
          if (
            (target === "stat" && args.at(-1) === "/proc/312/stat") ||
            (target === "uid" && args[5] === "id")
          ) {
            if (++count === 2)
              return target === "stat"
                ? value.replace("45678", "45679")
                : "10124\n";
          }
          return value;
        },
      }),
      /replaced|UID changed/,
    );
  }
});
