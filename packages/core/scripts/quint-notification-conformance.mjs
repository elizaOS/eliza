/** Runs the real notification inbox protocol tests for the Quint gate. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const repositoryRoot = path.resolve(packageRoot, "../..");
const models = [
	"NotificationHydration.qnt",
	"NotificationDurability.qnt",
	"NotificationGroupPolicy.qnt",
	"NativeNotificationCursor.qnt",
	"NotificationRecovery.qnt",
].map((name) => path.join(packageRoot, "quint", name));
if (
	process.argv.length > 3 ||
	(process.argv[2] &&
		!models.includes(path.resolve(repositoryRoot, process.argv[2])))
) {
	throw new Error("Notification conformance requires its own Quint model");
}

const requiredNames = new Set([
	"NotificationService rejects malformed persisted coordinates without overwriting the inbox",
	"NotificationService retains valid coordinate gaps and empty inbox watermarks across startup",
	"NotificationService recovers a repaired coordinate snapshot through the runtime lifecycle",
	"NotificationService restores committed migration coordinates after a lost acknowledgement",
	"NotificationService refuses an unencodable legacy coordinate map before replacing history",
	"NotificationService retains replacement cooldown when an older successful recovery receipt arrives late",
	"NotificationService keeps recovery backoff when real log event and agent-error observers throw",
	"NotificationService creates, stores, and returns a stamped notification",
	"NotificationService preserves exact lifeops reminder bodies in storage and events while generic bodies normalize",
	"NotificationService rejects an empty title",
	"NotificationService applies defaults for category/priority/source",
	"NotificationService broadcasts on the agent event bus as a notification stream",
	"NotificationService fans out durable single read and deletion without a new alert",
	"NotificationService fans out bulk read and clear only as committed updates",
	"NotificationService does not broadcast success when durable persistence rejects",
	"NotificationService does not broadcast success when durable persistence returns false",
	"NotificationService keeps committed reads when observer lookup and diagnostics throw",
	"NotificationService keeps committed reads when native projection unexpectedly throws",
	"NotificationService copies deleted records without asking for new native coordinates",
	"NotificationService keeps durable success when a live listener throws",
	"NotificationService serializes overlapping writes across one rejected persistence",
	"NotificationService serializes notify with concurrent removal without resurrecting the row",
	"NotificationService reconciles a committed removal failure before the next queued notify",
	"NotificationService awaits a rejected in-flight write before ensuring an exact grouped projection",
	"NotificationService replaces a stale grouped projection without inheriting coalesced count",
	"NotificationService retains every durable row through the exact-import boundary",
	"NotificationService preserves reminder channel ownership in native live events and pages without exporting private data",
	"NotificationService shares durable coordinates across copies, restart, deletion and clear without changing stored records",
	"NotificationService reports a changed epoch before checking its older cursor against a lower counter",
	"NotificationService pages a fixed append fence including read, low and expired rows despite deleted gaps",
	"NotificationService bounds encoded native pages without truncating producer content or their retained history",
	"NotificationService reconciles the sequence sidecar after ambiguous commits before the next queued write",
	"NotificationService blocks fences and later writes while an ambiguous commit cannot be read back",
	"NotificationService waits for the atomic durable mutation before exposing a native fence",
	"NotificationService migrates legacy insertion order atomically and retains coordinates across restart",
	"NotificationService still records when no event bus is present",
	"NotificationService fails startup when persisted notification state cannot be read",
	"NotificationService recovers persisted history after a transient hydration failure",
	"NotificationService backs off repeated recovery requests after a persistent failure",
	"NotificationService collapses notifications sharing a groupKey",
	"NotificationService lists newest-first and supports unreadOnly + category + limit filters",
	"NotificationService marks one and all read, updating unread count",
	"NotificationService removes and clears",
	"NotificationService persists to the runtime cache and rehydrates on restart",
	"NotificationService isolates notification payloads from producers and observers across restart",
	"NotificationService excludes a notification whose explicit expiresAt has passed",
	"NotificationService retains a notification with a future expiresAt",
	"NotificationService keeps expired durable rows addressable after rehydrate",
	"NotificationService retains oldest and newest notifications beyond the former cap",
	"NotificationService notify reflects unread count in the broadcast after collapse",
	"NotificationService defaults an approval notification to the interrupt tier (high)",
	"NotificationService defaults task/workflow notifications to the digest tier (normal)",
	"NotificationService defaults a routine system notification to the silent tier (low)",
	"NotificationService does not include silent-tier notifications in unread badge counts",
	"NotificationService lets a producer override the category default priority",
	"NotificationService defaults a low-priority notification to a 24h expiry",
	"NotificationService defaults expiry for a category that maps to the silent tier",
	"NotificationService never overrides a producer-set expiresAt on a low notification",
	"NotificationService honors explicit null expiresAt on a low notification",
	"NotificationService does NOT default an expiry for interrupt/digest tiers",
	"NotificationService carries data.count across same-groupKey supersede",
	"NotificationService leaves count absent for a first, un-superseded notification",
	"NotificationService honors a producer-set data.count instead of auto-incrementing",
	"NotificationService does not add a count to notifications without a groupKey",
	"NotificationService resets the count for a reused groupKey after the record expired away",
	"NotificationService marks the notification for a groupKey read when its action completes",
	"NotificationService broadcasts non-interruptive updates when marking a groupKey read",
	"NotificationService markReadByGroupKey returns 0 for an unknown or already-read group",
	"NotificationService markReadByGroupKey does not reorder the inbox (\u00a7C.2)",
	"NotificationService stop() drain and admission close drains the durable write tail before stop() resolves",
	"NotificationService stop() drain and admission close rejects writes admitted after stop() with an explicit error",
	"durable notification read evidence waits for the actual read write before exposing readAt",
	"durable notification read evidence does not expose uncommitted read evidence after ambiguous persistence fails",
	"NotificationService does not fan out markRead before durable commit",
	"NotificationService does not fan out remove before durable commit",
	"NotificationService does not fan out markAllRead before durable bulk commit",
	"NotificationService does not fan out clear before durable bulk commit",
]);
const outputRoot = testOutputPath("quint-notification");
mkdirSync(outputRoot, { recursive: true });
const reportPath = path.join(
	mkdtempSync(path.join(outputRoot, "conformance-")),
	"vitest.json",
);

const environment = { ...process.env };
// The existing suite uses its own real in-memory SQLite runtime adapter.
delete environment.POSTGRES_URL;
const child = spawn(
	process.execPath,
	[
		// The existing supervisor forwards cancellation through the full worker tree.
		path.join(repositoryRoot, "packages/scripts/run-with-deadline.ts"),
		"600000",
		"--",
		process.execPath,
		path.join(repositoryRoot, "packages/scripts/run-vitest.ts"),
		"run",
		"test/notification.test.ts",
		"--maxWorkers=1",
		"--no-cache",
		`--fsModuleCachePath=${path.join(path.dirname(reportPath), "module-cache")}`,
		"--retry=0",
		"--reporter=json",
		`--outputFile=${reportPath}`,
	],
	{
		cwd: packageRoot,
		env: environment,
		stdio: "inherit",
	},
);
let interrupted;
const interrupt = (signal) => {
	interrupted ??= signal;
	child.kill(signal);
};
const onInterrupt = () => interrupt("SIGINT");
const onTerminate = () => interrupt("SIGTERM");
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);
let result;
try {
	result = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
} finally {
	process.removeListener("SIGINT", onInterrupt);
	process.removeListener("SIGTERM", onTerminate);
}
if (interrupted || result.signal) {
	process.kill(process.pid, interrupted ?? result.signal);
} else if (result.code !== 0) {
	throw new Error(`Notification conformance runner exited with ${result.code}`);
} else {
	const report = JSON.parse(readFileSync(reportPath, "utf8"));
	const assertions = Array.isArray(report.testResults)
		? report.testResults.flatMap((file) => file.assertionResults ?? [])
		: [];
	const names = new Set(assertions.map((assertion) => assertion.fullName));
	if (
		report.success !== true ||
		report.numTotalTests !== requiredNames.size ||
		report.numPassedTests !== requiredNames.size ||
		report.numFailedTests !== 0 ||
		assertions.length !== requiredNames.size ||
		names.size !== requiredNames.size ||
		assertions.some((assertion) => assertion.status !== "passed") ||
		[...requiredNames].some((name) => !names.has(name))
	) {
		throw new Error(
			`Notification conformance did not pass all required tests. Report ${reportPath}`,
		);
	}
	console.log(
		`Notification conformance passed ${requiredNames.size} required tests`,
	);
	console.log(`JSON report ${reportPath}`);
}
