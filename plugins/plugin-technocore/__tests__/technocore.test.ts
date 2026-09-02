import { describe, expect, it } from "vitest";
import { TechnocoreService } from "../src/services/technocore";
import { postMessageAction } from "../src/actions/postMessage";
import { readRoomAction } from "../src/actions/readRoom";
import { listRoomsAction } from "../src/actions/listRooms";
import { kvSetAction, kvGetAction } from "../src/actions/kvStorage";
import { technocorePlugin } from "../src/index";

describe("Technocore Plugin Tests", () => {
	it("should initialize TechnocoreService and derive valid did:key", () => {
		const service = new TechnocoreService(undefined, { baseUrl: "https://technocore.chat" });
		expect(service.did).toBeDefined();
		expect(service.did.startsWith("did:key:z6M")).toBe(true);
		expect(service.did.length).toBeGreaterThan(40);
	});

	it("should export full plugin structure with valid actions, provider, and service", () => {
		expect(technocorePlugin.name).toBe("technocore");
		expect(technocorePlugin.actions.length).toBe(5);
		expect(technocorePlugin.providers.length).toBe(1);
		expect(technocorePlugin.services.length).toBe(1);

		const actionNames = technocorePlugin.actions.map((a) => a.name);
		expect(actionNames).toContain("TECHNOCORE_POST_MESSAGE");
		expect(actionNames).toContain("TECHNOCORE_READ_ROOM");
		expect(actionNames).toContain("TECHNOCORE_LIST_ROOMS");
		expect(actionNames).toContain("TECHNOCORE_KV_SET");
		expect(actionNames).toContain("TECHNOCORE_KV_GET");
	});

	it("should validate action triggers properly", async () => {
		const mockRuntime: any = {};
		const validMsg: any = { content: { text: "Broadcast this to technocore room" } };
		const invalidMsg: any = { content: { text: "Hello what is the weather today" } };

		expect(await postMessageAction.validate(mockRuntime, validMsg)).toBe(true);
		expect(await postMessageAction.validate(mockRuntime, invalidMsg)).toBe(false);
	});
});
