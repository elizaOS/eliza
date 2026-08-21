/** Unit coverage for BlueBubbles group mention/reply policy. */
import { describe, expect, it } from "vitest";
import {
	classifyBlueBubblesGroupInvocation,
	resolveBlueBubblesGroupResponsePolicy,
	shouldReplyToBlueBubblesGroup,
} from "../src/group-response-policy";

describe("BlueBubbles group response policy", () => {
	it("defaults invalid and absent settings to mention-only", () => {
		expect(resolveBlueBubblesGroupResponsePolicy(undefined)).toBe(
			"mention_only",
		);
		expect(resolveBlueBubblesGroupResponsePolicy("unknown")).toBe(
			"mention_only",
		);
	});

	it("recognizes @mentions, direct address, and replies to the agent", () => {
		expect(
			classifyBlueBubblesGroupInvocation({
				text: "hey @Eliza, can you help?",
				agentNames: ["Eliza"],
				isReplyToAgent: false,
			}),
		).toBe("mention");
		expect(
			classifyBlueBubblesGroupInvocation({
				text: "Test Agent: summarize this",
				agentNames: ["Test Agent", "Eliza"],
				isReplyToAgent: false,
			}),
		).toBe("mention");
		expect(
			classifyBlueBubblesGroupInvocation({
				text: "one more thing",
				agentNames: ["Eliza"],
				isReplyToAgent: true,
			}),
		).toBe("reply");
	});

	it("stores ambient turns silently unless ambient is explicit", () => {
		const invocation = classifyBlueBubblesGroupInvocation({
			text: "anyone want lunch?",
			agentNames: ["Eliza"],
			isReplyToAgent: false,
		});
		expect(invocation).toBe("ambient");
		expect(shouldReplyToBlueBubblesGroup("mention_only", invocation)).toBe(
			false,
		);
		expect(shouldReplyToBlueBubblesGroup("ambient", invocation)).toBe(true);
	});
});
