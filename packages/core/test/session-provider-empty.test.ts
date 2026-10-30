/**
 * Session providers add no prompt text when there is no session to report.
 * Live tj-786ca91739ceaa: every planner call carried "No session context
 * available." and "No session skills available." in an app DM.
 */
import { describe, expect, it } from "vitest";
import {
	createSessionProvider,
	createSessionSkillsProvider,
} from "../src/runtime/session-provider.ts";
import type { Memory } from "../src/types/memory.ts";
import type { IAgentRuntime } from "../src/types/runtime.ts";
import type { State } from "../src/types/state.ts";

const runtime = {} as IAgentRuntime;
const state = { values: {}, data: {}, text: "" } as State;
const withoutSession = {
	content: { text: "move it to 4pm" },
} as unknown as Memory;

describe("session providers", () => {
	it("add no text without a session", async () => {
		const session = await createSessionProvider().get(
			runtime,
			withoutSession,
			state,
		);
		const skills = await createSessionSkillsProvider().get(
			runtime,
			withoutSession,
			state,
		);
		expect(session).toEqual({ text: "", data: { hasSession: false } });
		expect(skills).toEqual({ text: "", data: { hasSkills: false } });
	});

	it("add no skills text for a session without skills", async () => {
		const result = await createSessionSkillsProvider().get(
			runtime,
			{
				sessionId: "agent:alpha:main",
				content: { text: "hi" },
			} as unknown as Memory,
			state,
		);
		expect(result).toEqual({
			text: "",
			data: { hasSkills: false, skills: [] },
		});
	});

	it("still describes a session that exists", async () => {
		const result = await createSessionProvider().get(
			runtime,
			{
				sessionId: "agent:alpha:main",
				content: { text: "hi" },
			} as unknown as Memory,
			state,
		);
		expect(result.text).toBe("Session ID: agent:alpha:main");
	});
});
