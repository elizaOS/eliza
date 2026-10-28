// Read-only Clock handler admission against a scripted adb; it never creates an alarm.
import assert from "node:assert/strict";
import test from "node:test";
import {
  clockActions,
  clockProductRequirement,
  requireClockProduct,
  verifyAospClockHandlers,
} from "../android/aosp-clock-handlers.mjs";

function image(options = {}) {
  const calls = [];
  return {
    calls,
    run: (...args) => {
      calls.push(args);
      if (args.includes("getprop"))
        return options.fingerprint ?? "fixture/image";
      if (args.includes("list"))
        return options.system === false && args.includes("-s")
          ? ""
          : (options.packages ?? "package:com.android.deskclock\n");
      if (args.includes("query-activities"))
        return args.includes(`android.intent.action.${options.missing}`)
          ? ""
          : (options.handler ?? "com.android.deskclock/.HandleApiCalls\n");
      throw Error("Unexpected device read");
    },
  };
}

test("Clock admission binds enabled system handlers to the reviewed image and user", () => {
  const device = image();
  const result = verifyAospClockHandlers(device.run, "10", "fixture/image");
  assert.equal(result.fingerprint, "fixture/image");
  assert.equal(result.user, "10");
  assert.equal(result.ringingVerified, false);
  assert.deepEqual(Object.keys(result.handlers), clockActions);
  for (const call of device.calls.filter((args) => !args.includes("getprop")))
    assert.equal(call[call.indexOf("--user") + 1], "10");
  assert.ok(device.calls.find((args) => args.includes("list")).includes("-s"));
  assert.ok(
    device.calls.every((args) => !args.includes("start")),
    "admission never creates an alarm",
  );
});

test("Clock admission refuses unbound images, sideload-only packages and incomplete handlers", () => {
  for (const user of [undefined, "-1", "01", "all"])
    assert.throws(
      () => verifyAospClockHandlers(image().run, user, "fixture/image"),
      /Explicit Android user/,
    );
  assert.throws(
    () => verifyAospClockHandlers(image().run, "0"),
    /expected image fingerprint/,
  );
  assert.throws(
    () =>
      verifyAospClockHandlers(
        image({ fingerprint: "different" }).run,
        "0",
        "fixture/image",
      ),
    /differs/,
  );
  assert.throws(
    () =>
      verifyAospClockHandlers(
        image({ system: false }).run,
        "0",
        "fixture/image",
      ),
    /system AOSP DeskClock/,
  );
  assert.throws(
    () =>
      verifyAospClockHandlers(
        image({ packages: "package:com.android.deskclock.fake\n" }).run,
        "0",
        "fixture/image",
      ),
    /system AOSP DeskClock/,
  );
  for (const missing of clockActions)
    assert.throws(
      () =>
        verifyAospClockHandlers(image({ missing }).run, "0", "fixture/image"),
      /Clock handler missing/,
    );
  assert.throws(
    () =>
      verifyAospClockHandlers(
        image({ handler: "other.package/.Clock" }).run,
        "0",
        "fixture/image",
      ),
    /Clock handler missing/,
  );
});

test("a product keeps exactly one DeskClock requirement", () => {
  const once = requireClockProduct("PRODUCT_PACKAGES += Launcher\n");
  assert.equal(
    once,
    `PRODUCT_PACKAGES += Launcher\n${clockProductRequirement}`,
  );
  assert.equal(requireClockProduct(once), once);
  assert.equal(
    requireClockProduct("PRODUCT_PACKAGES +=  DeskClock\n"),
    "PRODUCT_PACKAGES +=  DeskClock\n",
  );
  assert.notEqual(
    requireClockProduct("# PRODUCT_PACKAGES += DeskClock2\n"),
    "# PRODUCT_PACKAGES += DeskClock2\n",
  );
});
