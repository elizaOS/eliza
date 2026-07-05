// Unit-tests the walkthrough device-matrix runner's pure lane-aggregation:
// required-lane selection and the exit-code computation that fails the run when
// an attempted lane errors while keeping honest-`n/a` unavailable hosts green
// (#13573). No device is touched — matrices are fabricated in-process.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeExitCode,
  erroredLanes,
  formatDevicectlDeviceList,
  isDevicectlDeviceUsable,
  isLaneRequired,
  parseArgs,
  requiredLaneFailures,
  selectIosDeviceForMatrix,
} from "./walkthrough-device-matrix.mjs";

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
      ELIZA_IOS_DEVICE_ID: "env-ios",
    });

    assert.equal(args.serial, "device-1");
    assert.equal(args.iosDevice, "env-ios");
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

describe("walkthrough device matrix iOS physical-device planning (#13568)", () => {
  const payload = {
    result: {
      devices: [
        {
          identifier: "DISCONNECTED-ID",
          hardwareProperties: { udid: "DISCONNECTED-UDID" },
          deviceProperties: { name: "Old Phone" },
          state: "disconnected",
        },
        {
          identifier: "CONNECTED-ID",
          hardwareProperties: { udid: "CONNECTED-UDID" },
          deviceProperties: { name: "Lane iPhone" },
          state: "connected",
        },
      ],
    },
  };

  it("selects a connected iOS device instead of returning hardcoded n/a", () => {
    const selected = selectIosDeviceForMatrix(payload);

    assert.equal(selected.reason, null);
    assert.equal(selected.record.identifier, "CONNECTED-ID");
    assert.equal(selected.record.udid, "CONNECTED-UDID");
    assert.equal(selected.record.name, "Lane iPhone");
  });

  it("honors --ios-device by identifier, UDID, or name", () => {
    for (const requested of ["CONNECTED-ID", "CONNECTED-UDID", "Lane iPhone"]) {
      const selected = selectIosDeviceForMatrix(payload, requested);
      assert.equal(selected.record.identifier, "CONNECTED-ID");
      assert.equal(selected.reason, null);
    }
  });

  it("returns an honest devicectl-derived n/a reason for absent or unavailable devices", () => {
    assert.match(
      selectIosDeviceForMatrix(payload, "missing-phone").reason,
      /requested iOS device "missing-phone" was not found/,
    );
    assert.match(
      selectIosDeviceForMatrix(payload, "Old Phone").reason,
      /not connected\/available/,
    );
    assert.match(
      selectIosDeviceForMatrix({ result: { devices: [] } }).reason,
      /devicectl returned zero devices/,
    );
  });

  it("formats devicectl listings for matrix evidence", () => {
    const listing = formatDevicectlDeviceList(payload);

    assert.match(listing, /Old Phone id=DISCONNECTED-ID/);
    assert.match(listing, /Lane iPhone id=CONNECTED-ID/);
  });

  it("accepts older devicectl records without explicit state when identifier and UDID are present", () => {
    assert.equal(
      isDevicectlDeviceUsable({
        identifier: "LEGACY-ID",
        hardwareProperties: { udid: "LEGACY-UDID" },
      }),
      true,
    );
    assert.equal(
      isDevicectlDeviceUsable({
        identifier: "NO-UDID",
        state: "connected",
      }),
      false,
    );
  });
});
