import assert from "node:assert/strict";
import { registerAndroidReminders } from "@elizaos/macosreminders/android";

for (const name of ["", " ", " leading", "trailing "])
  assert.throws(() => registerAndroidReminders(name), /plugin name/);
const bridge = registerAndroidReminders("ExternalHostReminders");
await assert.rejects(
  bridge.listReminders(),
  (error) => error.code === "UNIMPLEMENTED",
);
console.log("External packed ESM import and no-web-fallback checks passed");
