import { describe, expect, it } from "vitest";
import {
	MESSAGE_SOURCE_CLIENT_CHAT,
	MESSAGE_SOURCE_SUB_AGENT,
	MESSAGE_SOURCES,
} from "./message-source";

describe("message source sentinels", () => {
	it("exports the canonical client-chat and sub-agent content.source markers", () => {
		expect(MESSAGE_SOURCE_CLIENT_CHAT).toBe("client_chat");
		expect(MESSAGE_SOURCE_SUB_AGENT).toBe("sub_agent");
		expect(MESSAGE_SOURCES).toEqual({
			CLIENT_CHAT: "client_chat",
			SUB_AGENT: "sub_agent",
		});
	});
});
