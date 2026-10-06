import assert from "node:assert/strict";
import { test } from "node:test";
import { waitAndInterruptAndroidPackage } from "./android-interruption.mjs";

function fixture(options = {}) {
  const calls = [];
  let stopped = false,
    custody = 0;
  const marker = { runId: "a".repeat(32), pid: 312, startTimeTicks: "45678" };
  const config = {
    packageName: "ai.example.helper",
    androidUser: 0,
    runId: marker.runId,
    markerPath: "files/evidence/armed.json",
    timeoutMs: 1000,
    assertCustody: async () => {
      if (++custody === options.lostCustodyAt) throw Error("Custody lost");
    },
    run: async (...args) => {
      calls.push(args);
      if (args.includes("force-stop")) {
        stopped = true;
        return "";
      }
      if (args.includes("ps"))
        return (
          "UID PID NAME\n" +
          (!stopped || options.survives
            ? "u0_a123 312 ai.example.helper\nu0_a123 313 bun\nu0_a124 314 other\n"
            : "u0_a124 314 other\n")
        );
      if (args.at(-1) === "-u") return "10123\n";
      if (args.at(-1) === config.markerPath) {
        if (options.missing)
          throw Object.assign(Error("missing"), {
            code: 1,
            stderr: "cat: No such file or directory",
          });
        if (options.permission)
          throw Object.assign(Error("denied"), {
            code: 1,
            stderr: "Permission denied",
          });
        return options.malformed
          ? "{"
          : JSON.stringify({ ...marker, ...options.marker });
      }
      if (args.at(-1) === "/proc/312/status")
        return "Uid: 10123 10123 10123 10123\n";
      if (args.at(-1) === "/proc/312/cmdline") return "ai.example.helper\0";
      if (args.at(-1) === "/proc/312/stat")
        return `312 (helper) S ${Array(18).fill("0").join(" ")} ${options.replaced && custody >= 2 ? "45679" : "45678"} 0\n`;
      throw Error(`Unexpected command ${args.join(" ")}`);
    },
  };
  return { config, calls };
}
test("owned interruption validates custody twice, kills only declared package/user and proves whole UID exit", async () => {
  const f = fixture();
  const receipt = await waitAndInterruptAndroidPackage(f.config);
  assert.equal(receipt.interrupted, true);
  assert.deepEqual(receipt.terminatedPids, [312, 313]);
  assert.equal(receipt.uidProcessesAfter, 0);
  assert.deepEqual(
    f.calls.filter((args) => args.includes("force-stop")),
    [["shell", "am", "force-stop", "--user", "0", "ai.example.helper"]],
  );
});
test("stale markers, replacement, permissions and lost custody refuse before force-stop", async () => {
  for (const options of [
    { marker: { runId: "b".repeat(32) } },
    { marker: { startTimeTicks: "45679" } },
    { replaced: true },
    { permission: true },
    { malformed: true },
    { lostCustodyAt: 1 },
    { lostCustodyAt: 2 },
  ]) {
    const f = fixture(options);
    await assert.rejects(waitAndInterruptAndroidPackage(f.config));
    assert.equal(
      f.calls.some((args) => args.includes("force-stop")),
      false,
    );
  }
});
test("missing readiness and surviving UID processes cannot produce an interruption receipt", async () => {
  for (const options of [{ missing: true }, { survives: true }]) {
    const f = fixture(options);
    await assert.rejects(
      waitAndInterruptAndroidPackage({ ...f.config, timeoutMs: 2000 }),
      /deadline/,
    );
    assert.equal(
      f.calls.filter((args) => args.includes("force-stop")).length,
      options.survives ? 1 : 0,
    );
  }
});
test("abort and invalid path/user/run selection never terminate a package", async () => {
  for (const change of [
    { signal: AbortSignal.abort(Error("cancelled")) },
    { markerPath: "files/../other.json" },
    { androidUser: -1 },
    { runId: "unknown" },
    { timeoutMs: 0 },
  ]) {
    const f = fixture();
    await assert.rejects(
      waitAndInterruptAndroidPackage({ ...f.config, ...change }),
    );
    assert.equal(
      f.calls.some((args) => args.includes("force-stop")),
      false,
    );
  }
});

test("interrupted instrumentation is distinct from pass, test failure, stale class and missing start", async () => {
  const { requireInstrumentationInterruption } = await import(
    "./instrumentation-result.mjs"
  );
  const output =
    "INSTRUMENTATION_STATUS: class=ai.example.Probe\nINSTRUMENTATION_STATUS: test=recovery\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 1\nINSTRUMENTATION_RESULT: shortMsg=Process crashed.\nINSTRUMENTATION_CODE: 0\n";
  assert.equal(
    requireInstrumentationInterruption(output, "ai.example.Probe", "recovery")
      .completed,
    0,
  );
  for (const bad of [
    output.replace("CODE: 1", "CODE: 0"),
    output.replace("ai.example.Probe", "ai.other.Probe"),
    output.replace("numtests=1", "numtests=2"),
    output.replace("INSTRUMENTATION_STATUS_CODE: 1\n", ""),
    output.replace("Process crashed.", "Permission denied"),
    `${output}OK (1 test)\n`,
    `${output}INSTRUMENTATION_CODE: 0\n`,
    `${output}INSTRUMENTATION_STATUS: test=another\n`,
  ])
    assert.throws(() =>
      requireInstrumentationInterruption(bad, "ai.example.Probe", "recovery"),
    );
});
