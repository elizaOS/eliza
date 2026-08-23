/** Runs one side of the fresh-process PGLite continuity proof. */
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import { ChannelType } from "../../types/primitives.ts";
import { stringToUuid } from "../../utils.ts";
import {
	loadSessionSummaryContentLedger,
	publishSessionSummaryContentManifests,
} from "./session-summary-content-manifest.ts";

const [mode, pgliteDir, encodedEnvelope] = process.argv.slice(2);
if (!mode || !pgliteDir)
	throw new Error("child mode and PGLite directory are required");
const { runtime, cleanup } = await createTestRuntime({
	characterName: "ContinuityFreshProcess",
	pgliteDir,
	removePgliteDirOnCleanup: false,
});
try {
	if (mode === "write") {
		const roomId = stringToUuid("fresh-process-room");
		const entityId = stringToUuid("fresh-process-entity");
		const worldId = stringToUuid("fresh-process-world");
		await runtime.createEntity({
			id: entityId,
			names: ["Fresh Process Entity"],
			agentId: runtime.agentId,
		});
		await runtime.createWorld({
			id: worldId,
			name: "Fresh Process World",
			agentId: runtime.agentId,
		});
		await runtime.createRoom({
			id: roomId,
			source: "continuity-test",
			type: ChannelType.DM,
			worldId,
		});
		const envelope = await publishSessionSummaryContentManifests({
			runtime,
			roomId,
			entityId,
			manifests: [
				{
					schemaVersion: 1,
					contentRefs: Array.from({ length: 80 }, (_, index) => ({
						reference: {
							kind: "document",
							ref: `document:${stringToUuid(`fresh-${index}`)}`,
							revision: "rev-1",
						},
						revision: "rev-1",
						reason: "fresh-process-proof",
						rangesUsed: [
							{ unit: "byte", start: index * 10, end: index * 10 + 9 },
						],
						lastUsedAt: new Date(
							Date.UTC(2026, 7, 22, 0, 0, index),
						).toISOString(),
						retained: true,
					})),
					modifiedFiles: [],
					pendingProcesses: [],
				},
			],
		});
		process.stdout.write(`CONTINUITY_RESULT=${JSON.stringify(envelope)}\n`);
	} else if (mode === "read") {
		if (!encodedEnvelope) throw new Error("reader envelope is required");
		const envelope = JSON.parse(
			Buffer.from(encodedEnvelope, "base64url").toString("utf8"),
		);
		const ledger = await loadSessionSummaryContentLedger(
			runtime,
			envelope,
			stringToUuid("fresh-process-room"),
		);
		const lateCanary = `document:${stringToUuid("fresh-79")}`;
		const lastRecord = ledger.records.at(-1);
		if (
			lastRecord?.kind !== "content-reference" ||
			lastRecord.value.reference.ref !== lateCanary
		) {
			throw new Error("fresh reader did not reach the late canary");
		}
		process.stdout.write(
			`CONTINUITY_RESULT=${JSON.stringify({ recordCount: ledger.records.length, lateCanary })}\n`,
		);
	} else throw new Error(`unsupported child mode: ${mode}`);
} finally {
	await cleanup();
}
