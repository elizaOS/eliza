/**
 * The system AOSP Clock (DeskClock) every launcher image keeps for alarms and
 * timers, and a read-only check that a booted image resolves its alarm intents.
 * Handler availability does not prove that an alarm rings.
 */
export const CLOCK_PACKAGE = "com.android.deskclock";
export const clockActions = Object.freeze([
  "SET_ALARM",
  "SHOW_ALARMS",
  "SNOOZE_ALARM",
  "DISMISS_ALARM",
]);
const CLOCK_LINE = /^\s*PRODUCT_PACKAGES\s*\+=\s*DeskClock\s*$/m;
export const clockProductRequirement =
  "\n# Alarms and timers stay with the system AOSP Clock (DeskClock).\nPRODUCT_PACKAGES += DeskClock\n";

/** The product makefile text with the DeskClock requirement present exactly once. */
export function requireClockProduct(makefile) {
  return CLOCK_LINE.test(makefile)
    ? makefile
    : `${makefile}${clockProductRequirement}`;
}

/** Read-only image admission bound to an exact image fingerprint and Android user. */
export function verifyAospClockHandlers(run, user, expectedFingerprint) {
  if (!/^(0|[1-9]\d*)$/.test(user || ""))
    throw Error("Explicit Android user required");
  if (!expectedFingerprint?.trim())
    throw Error("Explicit expected image fingerprint required");
  const fingerprint = run("shell", "getprop", "ro.build.fingerprint").trim();
  if (fingerprint !== expectedFingerprint)
    throw Error("Image fingerprint differs from expected target");
  const installed = run(
    "shell",
    "pm",
    "list",
    "packages",
    "--user",
    user,
    "-s",
    "-e",
    CLOCK_PACKAGE,
  );
  if (!installed.split(/\r?\n/).includes(`package:${CLOCK_PACKAGE}`))
    throw Error(
      "Required system AOSP DeskClock is not enabled for the selected user",
    );
  const handlers = {};
  for (const action of clockActions) {
    const output = run(
      "shell",
      "cmd",
      "package",
      "query-activities",
      "--brief",
      "--components",
      "--user",
      user,
      "-a",
      `android.intent.action.${action}`,
      "-c",
      "android.intent.category.DEFAULT",
      "-p",
      CLOCK_PACKAGE,
    );
    const matches = output
      .trim()
      .split(/\r?\n/)
      .filter((line) =>
        /^com\.android\.deskclock\/[A-Za-z0-9_.$]+$/.test(line.trim()),
      );
    if (!matches.length)
      throw Error(`Required Clock handler missing: ${action}`);
    handlers[action] = matches.map((line) => line.trim());
  }
  return {
    user,
    fingerprint,
    packageName: CLOCK_PACKAGE,
    handlers,
    ringingVerified: false,
  };
}
