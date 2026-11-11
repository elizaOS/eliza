import { describe, expect, it } from "vitest";
import {
	parseAgentSessionKey,
	resolveThreadParentSessionKey,
} from "../src/utils/session-key.ts";

describe("parseAgentSessionKey thread suffix", () => {
	it("does not mistake a subagent id of 'thread' for a thread marker", () => {
		const parsed = parseAgentSessionKey("agent:main:subagent:thread:foo");
		expect(parsed?.isSubagent).toBe(true);
		expect(parsed?.threadId).toBeUndefined();
		expect(parsed?.parentKey).toBeUndefined();
		expect(parsed?.rest).toBe("subagent:thread:foo");
		expect(resolveThreadParentSessionKey("agent:main:subagent:thread:foo")).toBe(
			"agent:main:subagent:thread:foo",
		);
	});

	it("does not mistake a channel named 'thread' for a thread marker", () => {
		const parsed = parseAgentSessionKey("agent:main:thread:dm:alice");
		expect(parsed?.threadId).toBeUndefined();
		expect(parsed?.parentKey).toBeUndefined();
		expect(parsed?.rest).toBe("thread:dm:alice");
	});

	it("still reads a real thread suffix after a DM rest", () => {
		const parsed = parseAgentSessionKey("agent:main:dm:alice:thread:t1");
		expect(parsed?.threadId).toBe("t1");
		expect(parsed?.parentKey).toBe("agent:main:dm:alice");
	});

	it("still reads a real thread suffix after a subagent rest", () => {
		const parsed = parseAgentSessionKey(
			"agent:main:subagent:alice:thread:t1",
		);
		expect(parsed?.threadId).toBe("t1");
		expect(parsed?.parentKey).toBe("agent:main:subagent:alice");
	});
});
