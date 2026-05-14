import { describe, expect, test } from "vitest";
import { ChannelType } from "../types/primitives";
import { channelPrivacyClassProvider } from "./channel-privacy-class";

function createRuntime() {
	return { agentId: "agent-1" } as unknown;
}

describe("CHANNEL_PRIVACY_CLASS provider", () => {
	test("classifies a DM channel as dm", async () => {
		const result = await channelPrivacyClassProvider.get(
			createRuntime() as never,
			{
				entityId: "user-1",
				roomId: "room-1",
				content: { text: "", channelType: ChannelType.DM },
			} as never,
			{} as never,
		);
		expect(result.data?.channelPrivacy).toBe("dm");
		expect(result.data?.channelId).toBe("room-1");
	});

	test("falls back to unknown when channelType is absent", async () => {
		const result = await channelPrivacyClassProvider.get(
			createRuntime() as never,
			{
				entityId: "user-1",
				roomId: undefined,
				content: { text: "" },
			} as never,
			{} as never,
		);
		expect(result.data?.channelPrivacy).toBe("unknown");
		expect(result.data?.channelId).toBeUndefined();
	});
});
