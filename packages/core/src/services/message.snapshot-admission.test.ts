/**
 * Exercises snapshot mutation admission at the real message-service entry
 * point, including release after a terminal short-circuit.
 */

import { afterEach, describe, expect, test } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../types/index.ts";
import { DefaultMessageService } from "./message.ts";
import { getSnapshotCaptureBarrier } from "./snapshot-capture-barrier.ts";

const ROOM_ID = "10000000-0000-4000-8000-000000000001" as UUID;

afterEach(() => {
	delete process.env.ELIZA_ENABLE_ANALYSIS_MODE;
});

describe("DefaultMessageService snapshot admission", () => {
	test("rejects a turn once snapshot draining has closed admission", async () => {
		const runtime = {} as IAgentRuntime;
		getSnapshotCaptureBarrier(runtime).beginDraining();

		await expect(
			new DefaultMessageService().handleMessage(runtime, {
				content: { text: "hello" },
				roomId: ROOM_ID,
			} as Memory),
		).rejects.toMatchObject({
			code: "AGENT_SNAPSHOT_MUTATION_ADMISSION_CLOSED",
		});
	});

	test("releases admission when a terminal turn returns", async () => {
		process.env.ELIZA_ENABLE_ANALYSIS_MODE = "1";
		const runtime = {} as IAgentRuntime;
		const barrier = getSnapshotCaptureBarrier(runtime);

		await expect(
			new DefaultMessageService().handleMessage(runtime, {
				content: { text: "analysis" },
				roomId: ROOM_ID,
			} as Memory),
		).resolves.toMatchObject({ reason: "analysis-mode-token" });
		expect(barrier.status().activeMutations).toBe(0);
	});
});
