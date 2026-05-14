import { describe, expect, it } from "vitest";
import type { UUID } from "../../../types/primitives.ts";
import type { IAgentRuntime, Memory, State } from "../../../types/index.ts";
import { userEmotionSignalProvider } from "./userEmotionSignal.ts";

function makeRuntime(
	setting?: string | undefined,
): IAgentRuntime {
	return {
		getSetting: (key: string) =>
			key === "ELIZA_VOICE_EMOTION_INTO_PLANNER" ? setting : undefined,
	} as unknown as IAgentRuntime;
}

function makeMessage(content: Record<string, unknown>): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		roomId: "00000000-0000-0000-0000-000000000004" as UUID,
		content,
		createdAt: 1,
	} as Memory;
}

const emptyState = { values: {}, data: {}, text: "" } as State;

describe("userEmotionSignalProvider", () => {
	it("stays silent when no emotion data is present", async () => {
		const result = await userEmotionSignalProvider.get(
			makeRuntime(),
			makeMessage({ text: "hello" }),
			emptyState,
		);
		expect(result.text).toBe("");
	});

	it("emits USER_SIGNAL line when voice emotion is above the threshold", async () => {
		const result = await userEmotionSignalProvider.get(
			makeRuntime(),
			makeMessage({
				text: "I am furious",
				metadata: {
					voice: {
						emotion: {
							label: "angry",
							confidence: 0.82,
							method: "acoustic_text_fused",
						},
					},
				},
			}),
			emptyState,
		);
		expect(result.text).toMatch(/^USER_SIGNAL: voice emotion = angry/);
		expect(result.values?.userEmotionVoiceLabel).toBe("angry");
	});

	it("ignores low-confidence voice emotion reads", async () => {
		const result = await userEmotionSignalProvider.get(
			makeRuntime(),
			makeMessage({
				text: "I am furious",
				metadata: {
					voice: {
						emotion: { label: "angry", confidence: 0.4 },
					},
				},
			}),
			emptyState,
		);
		expect(result.text).toBe("");
	});

	it("includes text emotion when Content.emotion is set to a non-none value", async () => {
		const result = await userEmotionSignalProvider.get(
			makeRuntime(),
			makeMessage({ text: "yes please", emotion: "excited" }),
			emptyState,
		);
		expect(result.text).toMatch(/text emotion = excited/);
	});

	it("treats Content.emotion=none as no signal", async () => {
		const result = await userEmotionSignalProvider.get(
			makeRuntime(),
			makeMessage({ text: "ok", emotion: "none" }),
			emptyState,
		);
		expect(result.text).toBe("");
	});

	it("opt-out via ELIZA_VOICE_EMOTION_INTO_PLANNER=0 silences the provider", async () => {
		const result = await userEmotionSignalProvider.get(
			makeRuntime("0"),
			makeMessage({
				text: "still angry",
				metadata: {
					voice: { emotion: { label: "angry", confidence: 0.9 } },
				},
				emotion: "angry",
			}),
			emptyState,
		);
		expect(result.text).toBe("");
	});

	it("declares position=-5 and contextGate=general (planner contract)", () => {
		expect(userEmotionSignalProvider.position).toBe(-5);
		expect(userEmotionSignalProvider.contextGate?.anyOf).toContain("general");
	});
});
