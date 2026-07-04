import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isLaneRequired,
  parseArgs,
  requiredLaneFailures,
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
    });

    assert.equal(args.serial, "device-1");
    assert.equal(args.driveAndroid, false);
  });
});
