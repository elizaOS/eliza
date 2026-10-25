import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { registerAndroidCalendar } from "@elizaos/capacitor-calendar/android";

const { AppleCalendar } = createRequire(import.meta.url)(
  "@elizaos/capacitor-calendar",
);
assert.equal((await AppleCalendar.checkPermissions()).calendar, "restricted");
assert.throws(() => registerAndroidCalendar(""));
const calendar = registerAndroidCalendar("ExternalPackedCalendar");
assert.equal(typeof calendar.requestAccess, "function");
await assert.rejects(calendar.requestAccess(), /not implemented/i);
console.log(
  "Packed Calendar entrypoint imported; absent native implementation rejects",
);
