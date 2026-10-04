import assert from "node:assert/strict";
import test from "node:test";
import {
  fixtureNetworkDiagnostics,
  parseFixtureNetwork,
  parseNetworkValidationProbes,
  prepareFixtureNetwork,
} from "./ci-emulator-network.mjs";

const connected =
  "Active default network: 101\n  NetworkAgentInfo{network{101} handle{123} nc{[ Transports: WIFI Capabilities: INTERNET&NOT_RESTRICTED&VALIDATED LinkUpBandwidth>=1000]}\n";
const disconnected = "Active default network: none\n";
const options = {
  env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" },
  serial: "emulator-5554",
  sleep: async () => {},
};
function fixture({
  neverReady = false,
  packages = "",
  user = "0",
  initiallyReady = false,
  stuckRadio = false,
} = {}) {
  let requested = false,
    wifiEnabled = true,
    radioWasDisabled = false;
  const calls = [];
  const run = (...args) => {
    const key = args.join(" ");
    calls.push(key);
    const responses = {
      "emu avd name": "test\nOK",
      "shell getprop ro.kernel.qemu": "1",
      "shell getprop ro.build.type": "userdebug",
      "shell am get-current-user": user,
      "shell pm list users": "Users:\n UserInfo{0:Owner:4c13} running",
      "shell pm list packages -3": packages,
      "shell cmd wifi status": wifiEnabled
        ? 'Wifi is enabled\nWifi is connected to "AndroidWifi"\nSupplicant state: COMPLETED,'
        : "Wifi is disabled",
      "shell settings get global airplane_mode_on": "0",
      "shell settings get global mobile_data": "1",
    };
    if (key in responses) return responses[key];
    if (key === "shell dumpsys connectivity")
      return initiallyReady || (requested && !neverReady)
        ? connected
        : disconnected;
    if (key === "shell cmd wifi set-wifi-enabled disabled") {
      if (!stuckRadio) {
        wifiEnabled = false;
        radioWasDisabled = true;
      }
      return "";
    }
    if (key === "shell cmd wifi set-wifi-enabled enabled") {
      wifiEnabled = true;
      return "";
    }
    if (key === "shell cmd wifi connect-network AndroidWifi open") {
      requested = radioWasDisabled && wifiEnabled;
      return "Connection initiated";
    }
    throw Error(`Unexpected command: ${key}`);
  };
  return { run, calls };
}
const writes = (calls) =>
  calls.filter(
    (call) =>
      call.startsWith("shell cmd wifi") && call !== "shell cmd wifi status",
  );

test("only the active network capabilities can admit Internet access", () => {
  assert.deepEqual(parseFixtureNetwork(connected), {
    active: true,
    internet: true,
    validated: true,
  });
  assert.deepEqual(parseFixtureNetwork(disconnected), {
    active: false,
    internet: false,
    validated: false,
  });
  assert.equal(
    parseFixtureNetwork(connected.replace("&VALIDATED", "&NOT_VALIDATED"))
      .validated,
    false,
  );
  assert.equal(
    parseFixtureNetwork(connected.replace("INTERNET&", "")).internet,
    false,
  );
  for (const text of [
    "",
    connected.replace("network{101}", "network{102}"),
    connected + connected,
    connected.replace("Capabilities:", "Unavailable:"),
  ])
    assert.throws(() => parseFixtureNetwork(text), /Unknown fixture/);
});
test("preparation connects once and requires two actual ready observations", async () => {
  const f = fixture({ packages: "package:com.android.webview" }),
    records = [];
  await prepareFixtureNetwork(f.run, {
    ...options,
    record: (state) => records.push(state),
  });
  assert.deepEqual(writes(f.calls), [
    "shell cmd wifi set-wifi-enabled disabled",
    "shell cmd wifi set-wifi-enabled enabled",
    "shell cmd wifi connect-network AndroidWifi open",
  ]);
  assert.deepEqual(
    records.filter((row) => row.phase === "radio").map((row) => row.enabled),
    [false, true],
  );
  assert.equal(
    records.filter((row) => row.phase === "admission" && row.validated).length,
    2,
  );
  assert.equal(JSON.stringify(records).includes("101"), false);
});
test("already connected fixtures are only observed", async () => {
  const f = fixture({ initiallyReady: true });
  await prepareFixtureNetwork(f.run, options);
  assert.deepEqual(writes(f.calls), []);
});
test("a successful connect command cannot substitute for a working network", async () => {
  const f = fixture({ neverReady: true }),
    records = [];
  let waits = 0;
  await assert.rejects(
    prepareFixtureNetwork(f.run, {
      ...options,
      record: (row) => records.push(row),
      sleep: async () => {
        waits++;
      },
    }),
    /no validated Internet/,
  );
  assert.equal(waits, 60);
  assert.equal(writes(f.calls).length, 3);
  assert.equal(records.at(-1).phase, "diagnostics-failed");
  assert.equal(records.at(-1).fixtureAccessPointConnected, true);
});
test("a successful disable command cannot substitute for observing the radio stop", async () => {
  const f = fixture({ stuckRadio: true });
  let waits = 0;
  await assert.rejects(
    prepareFixtureNetwork(f.run, {
      ...options,
      sleep: async () => {
        waits++;
      },
    }),
    /radio transition/,
  );
  assert.equal(waits, 40);
  assert.deepEqual(writes(f.calls), [
    "shell cmd wifi set-wifi-enabled disabled",
  ]);
});
test("network diagnostics retain only known states and never raw identifiers or errors", () => {
  const f = fixture();
  const result = fixtureNetworkDiagnostics((...args) =>
    args.join(" ") === "shell cmd wifi status"
      ? 'Wifi is enabled\nWifi is connected to "private-network"\nIP: /192.0.2.42, Supplicant state: COMPLETED, MAC: private-mac'
      : f.run(...args),
  );
  assert.deepEqual(result, {
    airplaneMode: false,
    mobileDataEnabled: true,
    wifiStatusAvailable: true,
    validationProbes: [],
    wifiEnabled: true,
    fixtureAccessPointConnected: false,
    supplicantState: "COMPLETED",
  });
  assert.doesNotMatch(JSON.stringify(result), /private|192\.0/);
  const unavailable = fixtureNetworkDiagnostics(() => {
    throw Error("private-output");
  });
  assert.equal(unavailable.wifiStatusAvailable, false);
  assert.equal(unavailable.airplaneMode, null);
  assert.equal(unavailable.supplicantState, null);
  assert.doesNotMatch(JSON.stringify(unavailable), /private/);
});
test("local contexts, populated fixtures, secondary users and identity drift refuse writes", async () => {
  const local = fixture();
  await assert.rejects(
    prepareFixtureNetwork(local.run, { ...options, env: {} }),
  );
  assert.deepEqual(local.calls, []);
  for (const setup of [
    { packages: "package:com.example.consumer" },
    { user: "10" },
  ]) {
    const f = fixture(setup);
    await assert.rejects(prepareFixtureNetwork(f.run, options));
    assert.deepEqual(writes(f.calls), []);
  }
  const f = fixture();
  let users = 0;
  await assert.rejects(
    prepareFixtureNetwork(
      (...args) =>
        args.join(" ") === "shell am get-current-user" && ++users > 1
          ? "10"
          : f.run(...args),
      options,
    ),
  );
  assert.deepEqual(writes(f.calls), []);
});

test("validation diagnostics retain probe outcomes without network payloads", () => {
  const probes = parseNetworkValidationProbes(
    [
      "PROBE_DNS private.example 2ms FAIL resNetworkQuery failed: ENONET (Machine is not on the network)",
      "PROBE_HTTPS https://private.example/token time=35ms ret=204 headers={Authorization=[private-token]}",
      "PROBE_DNS private.example 1ms OK 192.0.2.1",
      "PROBE_FALLBACK private-payload",
      "PROBE_UNKNOWN private-payload",
    ].join("\n"),
  );
  assert.deepEqual(probes, [
    { kind: "DNS", status: "failed", httpStatus: null, errorCode: "ENONET" },
    { kind: "HTTPS", status: "completed", httpStatus: 204, errorCode: null },
    { kind: "DNS", status: "completed", httpStatus: null, errorCode: null },
    { kind: "FALLBACK", status: "unknown", httpStatus: null, errorCode: null },
  ]);
  assert.doesNotMatch(JSON.stringify(probes), /private|192\.0|Authorization/);
});
