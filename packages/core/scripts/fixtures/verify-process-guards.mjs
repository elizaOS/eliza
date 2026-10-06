import assert from "node:assert/strict";

const before = process.listenerCount("uncaughtException");
const { installProcessCrashGuards } = await import("@elizaos/host");
assert.equal(
	process.listenerCount("uncaughtException"),
	before,
	"importing host must not install guards",
);
assert.equal(installProcessCrashGuards(), true);
assert.equal(installProcessCrashGuards(), false, "installation is idempotent");
assert.equal(process.listenerCount("uncaughtException"), before + 1);
setTimeout(() => {
	throw new Error("packed-host-crash-fixture");
}, 0);
