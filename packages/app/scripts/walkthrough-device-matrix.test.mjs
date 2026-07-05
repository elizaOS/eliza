// Unit-tests the walkthrough device-matrix runner's pure lane-aggregation:
// required-lane selection and the exit-code computation that fails the run when
// an attempted lane errors while keeping honest-`n/a` unavailable hosts green
// (#13573). No device is touched — matrices are fabricated in-process.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  captureIos,
  captureIosDevice,
  computeExitCode,
  erroredLanes,
  iosDeviceConnectionState,
  isLaneRequired,
  parseArgs,
  requiredLaneFailures,
  selectIosDevice,
} from "./walkthrough-device-matrix.mjs";

const devicectlPayload = (devices) => ({ result: { devices } });
const iphone = ({
  identifier = "59EBB356-BC44-5AA2-91F1-E6AAE756BB86",
  udid = "00008140-000A1D2E3F40001E",
  name = "MoonCycles",
  tunnelState = "connected",
} = {}) => ({
  identifier,
  hardwareProperties: { udid },
  deviceProperties: { name },
  connectionProperties: { tunnelState },
});

describe("walkthrough device matrix required lanes", () => {
  it("parses required platforms from env and flags", () => {
    const args = parseArgs(
      ["--platform", "android", "--require", "ios,device"],
      {
        WALKTHROUGH_REQUIRE: "android",
      },
    );

    assert.equal(args.platform, "android");
    assert.deepEqual([...args.require].sort(), ["android", "device", "ios"]);
  });

  it("treats android as covering emulator and device android lanes", () => {
    const args = parseArgs(["--require", "android"], {});

    assert.equal(isLaneRequired("android-emulator", args.require), true);
    assert.equal(isLaneRequired("android-device", args.require), true);
    assert.equal(isLaneRequired("ios-simulator", args.require), false);
  });

  it("only fails n/a lanes when the lane is required", () => {
    const matrix = {
      "android-emulator": { status: "n/a", reason: "adb blocked" },
      "ios-simulator": { status: "n/a", reason: "not on macOS" },
    };

    const failures = requiredLaneFailures(
      matrix,
      parseArgs(["--require", "android"], {}).require,
    );

    assert.deepEqual(
      failures.map(([name]) => name),
      ["android-emulator"],
    );
  });

  it("keeps passive n/a lanes non-fatal when nothing is required", () => {
    const matrix = {
      "android-emulator": { status: "n/a", reason: "no device" },
    };

    assert.deepEqual(requiredLaneFailures(matrix, new Set()), []);
  });

  it("preserves explicit serials and allows disabling Android drive", () => {
    const args = parseArgs(["--serial", "device-1", "--skip-android-drive"], {
      ANDROID_SERIAL: "env-device",
    });

    assert.equal(args.serial, "device-1");
    assert.equal(args.driveAndroid, false);
  });
});

describe("walkthrough device matrix exit code", () => {
  const noRequire = new Set();

  it("exits 0 when every attempted lane succeeded", () => {
    const matrix = {
      "ios-simulator": { status: "captured", reason: null },
      "android-emulator": { status: "captured", reason: null },
    };
    assert.deepEqual(erroredLanes(matrix), []);
    assert.equal(computeExitCode(matrix, noRequire), 0);
  });

  it("exits non-zero when ANY attempted lane errored, even without --require", () => {
    const matrix = {
      "ios-simulator": { status: "error", reason: null },
      "android-emulator": { status: "captured", reason: null },
    };
    assert.deepEqual(
      erroredLanes(matrix).map(([name]) => name),
      ["ios-simulator"],
    );
    assert.equal(computeExitCode(matrix, noRequire), 1);
  });

  it("exits 0 when lanes are only honestly n/a (unavailable host)", () => {
    const matrix = {
      "ios-simulator": { status: "n/a", reason: "not on macOS" },
      "android-emulator": { status: "n/a", reason: "no device" },
    };
    assert.equal(computeExitCode(matrix, noRequire), 0);
  });

  it("exits 0 for a mix of n/a and successful lanes", () => {
    const matrix = {
      "ios-simulator": { status: "n/a", reason: "no booted simulator" },
      "android-emulator": { status: "captured", reason: null },
    };
    assert.equal(computeExitCode(matrix, noRequire), 0);
  });

  it("exits non-zero when an errored lane is mixed with honest n/a lanes", () => {
    const matrix = {
      "ios-simulator": { status: "n/a", reason: "no booted simulator" },
      "android-emulator": { status: "error", reason: null },
    };
    assert.equal(computeExitCode(matrix, noRequire), 1);
  });

  it("still fails a --require'd n/a lane (honest-N/A + --require intact)", () => {
    const matrix = {
      "android-emulator": { status: "n/a", reason: "adb blocked" },
    };
    // No lane errored, so the error path is not what fails this one.
    assert.deepEqual(erroredLanes(matrix), []);
    assert.equal(
      computeExitCode(matrix, parseArgs(["--require", "android"], {}).require),
      1,
    );
  });
});

// #13568: the iOS physical-device lane was hardcoded `n/a` with a canned reason
// and performed no detection at all. These tests pin the pure detect/branch
// logic that now decides "run the real on-device capture" vs "record an honest
// n/a derived from the actual devicectl probe" — no device is touched.
describe("iOS device detection (selectIosDevice)", () => {
  it("normalizes the devicectl tunnel/connection state", () => {
    assert.equal(
      iosDeviceConnectionState(iphone({ tunnelState: "Connected" })),
      "connected",
    );
    assert.equal(iosDeviceConnectionState({}), "unknown");
  });

  it("picks the first connected device when none is requested", () => {
    const payload = devicectlPayload([
      iphone({ name: "Sleeping", tunnelState: "unavailable" }),
      iphone({ name: "Live", tunnelState: "connected" }),
    ]);
    const { device, reason } = selectIosDevice(payload);
    assert.equal(reason, null);
    assert.equal(device.deviceProperties.name, "Live");
  });

  it("records an honest n/a naming the listing when nothing is connected", () => {
    const { device, reason } = selectIosDevice(
      devicectlPayload([iphone({ tunnelState: "disconnected" })]),
    );
    assert.equal(device, null);
    assert.match(reason, /no connected iOS device/);
    assert.match(reason, /MoonCycles \[disconnected\]/);
  });

  it("reports no paired devices when the listing is empty", () => {
    const { device, reason } = selectIosDevice(devicectlPayload([]));
    assert.equal(device, null);
    assert.match(reason, /no paired devices/);
  });

  it("honors a requested id (udid / identifier / name) and requires it be connected", () => {
    const payload = devicectlPayload([
      iphone({ name: "A", udid: "UDID-A", tunnelState: "connected" }),
      iphone({
        name: "B",
        identifier: "ID-B",
        udid: "UDID-B",
        tunnelState: "connected",
      }),
    ]);
    for (const key of ["UDID-B", "ID-B", "B", "b"]) {
      const { device } = selectIosDevice(payload, { requestedId: key });
      assert.equal(device?.deviceProperties?.name, "B", `matched by ${key}`);
    }
    const missing = selectIosDevice(payload, { requestedId: "ghost" });
    assert.equal(missing.device, null);
    assert.match(missing.reason, /not present in devicectl listing/);

    const asleep = selectIosDevice(
      devicectlPayload([iphone({ name: "Z", tunnelState: "unavailable" })]),
      { requestedId: "Z" },
    );
    assert.equal(asleep.device, null);
    assert.match(
      asleep.reason,
      /is not connected \(devicectl state: unavailable\)/,
    );
  });
});

describe("iOS device lane (captureIosDevice)", () => {
  const connectedPayload = devicectlPayload([iphone()]);

  it("records n/a off darwin without probing devicectl", () => {
    let probed = false;
    const result = captureIosDevice({
      deps: {
        onDarwin: false,
        readDeviceList: () => {
          probed = true;
          return connectedPayload;
        },
      },
    });
    assert.equal(result.status, "n/a");
    assert.match(result.reason, /macOS/);
    assert.equal(probed, false);
  });

  it("records n/a with the devicectl error when the probe throws", () => {
    const result = captureIosDevice({
      deps: {
        onDarwin: true,
        readDeviceList: () => {
          throw new Error("xcrun: command not found");
        },
      },
    });
    assert.equal(result.status, "n/a");
    assert.match(result.reason, /devicectl.*unavailable/);
    assert.match(result.reason, /xcrun: command not found/);
  });

  it("records n/a naming ios:device:deploy when a device is present but the staged app is missing", () => {
    let ran = false;
    const result = captureIosDevice({
      deps: {
        onDarwin: true,
        readDeviceList: () => connectedPayload,
        stagedAppExists: () => false,
        run: () => {
          ran = true;
          return 0;
        },
      },
    });
    assert.equal(result.status, "n/a");
    assert.match(result.reason, /ios:device:deploy/);
    assert.equal(ran, false, "must not attempt capture without the staged app");
  });

  it("runs the real capture and records `captured` with the output dir when device + staged app are present", () => {
    let invoked = null;
    const result = captureIosDevice({
      iosDevice: null,
      deps: {
        onDarwin: true,
        readDeviceList: () => connectedPayload,
        stagedApp: "/stage/App.app",
        stagedAppExists: () => true,
        run: (rel, argv) => {
          invoked = { rel, argv };
          return 0;
        },
      },
    });
    assert.equal(result.status, "captured");
    assert.equal(invoked.rel, "ios-device-capture.mjs");
    assert.deepEqual(
      [
        invoked.argv[invoked.argv.indexOf("--platform") + 1],
        invoked.argv[invoked.argv.indexOf("--device") + 1],
        invoked.argv[invoked.argv.indexOf("--app-path") + 1],
      ],
      ["device", "59EBB356-BC44-5AA2-91F1-E6AAE756BB86", "/stage/App.app"],
    );
    assert.ok(invoked.argv.includes("--skip-build"));
    assert.equal(
      result.outputDir,
      invoked.argv[invoked.argv.indexOf("--output") + 1],
    );
  });

  it("records `error` (never a false-green) when the on-device capture exits non-zero", () => {
    const result = captureIosDevice({
      deps: {
        onDarwin: true,
        readDeviceList: () => connectedPayload,
        stagedApp: "/stage/App.app",
        stagedAppExists: () => true,
        run: () => 1,
      },
    });
    assert.equal(result.status, "error");
    // An attempted-and-errored lane is always fatal, independent of --require.
    assert.equal(computeExitCode({ "ios-device": result }, new Set()), 1);
  });
});

describe("iOS simulator lane (captureIos)", () => {
  it("records honest n/a without running phases when no simulator is booted", () => {
    let ran = false;
    const result = captureIos({
      duration: 1,
      deps: {
        bootedSim: () => null,
        appBuilt: () => "/DerivedData/App.app",
        run: () => {
          ran = true;
          return 0;
        },
      },
    });
    assert.equal(result.status, "n/a");
    assert.match(result.reason, /no booted iOS simulator/);
    assert.equal(ran, false);
  });

  it("records honest n/a without running phases when no fresh simulator build exists", () => {
    let ran = false;
    const result = captureIos({
      duration: 1,
      deps: {
        bootedSim: () => "SIM-UDID",
        appBuilt: () => null,
        run: () => {
          ran = true;
          return 0;
        },
      },
    });
    assert.equal(result.status, "n/a");
    assert.match(result.reason, /build:ios:local:sim/);
    assert.equal(ran, false);
  });

  it("runs onboarding, local chat, then capture for an available simulator", () => {
    const invocations = [];
    const result = captureIos({
      duration: 7,
      deps: {
        bootedSim: () => "SIM-UDID",
        appBuilt: () => "/DerivedData/App.app",
        run: (rel, argv) => {
          invocations.push({ rel, argv });
          return 0;
        },
      },
    });
    assert.equal(result.status, "captured");
    assert.deepEqual(
      invocations.map((entry) => entry.rel),
      [
        "ios-onboarding-smoke.mjs",
        "mobile-local-chat-smoke.mjs",
        "capture-ios-sim.mjs",
      ],
    );
    assert.deepEqual(invocations[0].argv, [
      "--app-path",
      "/DerivedData/App.app",
    ]);
    assert.deepEqual(invocations[1].argv, [
      "--platform",
      "ios",
      "--require-installed",
      "--ios-select-local",
      "--ios-full-bun-smoke",
    ]);
    assert.equal(
      invocations[2].argv[invocations[2].argv.indexOf("--duration") + 1],
      "7",
    );
    assert.deepEqual(
      result.phases.map((phase) => phase.status),
      ["ok", "ok", "ok"],
    );
  });

  it("records error and makes the lane fatal when any attempted simulator phase fails", () => {
    const invocations = [];
    const result = captureIos({
      duration: 1,
      deps: {
        bootedSim: () => "SIM-UDID",
        appBuilt: () => "/DerivedData/App.app",
        run: (rel) => {
          invocations.push(rel);
          return rel === "mobile-local-chat-smoke.mjs" ? 23 : 0;
        },
      },
    });
    assert.equal(result.status, "error");
    assert.equal(result.reason, "mobile-local-chat-smoke.mjs");
    assert.equal(result.phases[1].exitCode, 23);
    assert.deepEqual(invocations, [
      "ios-onboarding-smoke.mjs",
      "mobile-local-chat-smoke.mjs",
    ]);
    assert.equal(computeExitCode({ "ios-simulator": result }, new Set()), 1);
  });
});
