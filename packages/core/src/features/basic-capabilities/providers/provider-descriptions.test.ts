import { describe, expect, it, vi } from "vitest";
import { adminChatProvider } from "../../autonomy/providers.ts";
import {
	platformChatContextProvider,
	platformUserContextProvider,
} from "./platformContext.ts";
import { recentMessagesProvider } from "./recentMessages.ts";

vi.mock("../../autonomy/service.ts", () => ({
	AUTONOMY_SERVICE_TYPE: "AUTONOMY_SERVICE",
}));

describe("conversation-history provider descriptions", () => {
	it("keeps current-room transcript, connector context, user identity, and admin history distinct", () => {
		const providers = [
			recentMessagesProvider,
			platformChatContextProvider,
			platformUserContextProvider,
			adminChatProvider,
		];

		expect(providers.map((provider) => provider.name)).toEqual([
			"RECENT_MESSAGES",
			"PLATFORM_CHAT_CONTEXT",
			"PLATFORM_USER_CONTEXT",
			"ADMIN_CHAT_HISTORY",
		]);

		const descriptions = providers.map((provider) =>
			(provider.description ?? "").trim(),
		);
		expect(new Set(descriptions).size).toBe(descriptions.length);

		expect(recentMessagesProvider.description).toContain(
			"Canonical bounded transcript for the current room",
		);
		expect(platformChatContextProvider.description).toContain(
			"Connector-specific room metadata",
		);
		expect(platformChatContextProvider.description).toContain(
			"not the canonical transcript",
		);
		expect(platformUserContextProvider.description).toContain(
			"Connector-specific sender identity metadata",
		);
		expect(platformUserContextProvider.description).toContain(
			"not conversation history",
		);
		expect(adminChatProvider.description).toContain(
			"Autonomy-only admin control-room history",
		);
	});
});
