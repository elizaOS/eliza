import crypto from "node:crypto";
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

	it("should deterministically load identity from privateKeyHex", () => {
		const testSeed = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		const service1 = new TechnocoreService(undefined, { privateKeyHex: testSeed });
		const service2 = new TechnocoreService(undefined, { privateKeyHex: testSeed });

		expect(service1.did).toEqual(service2.did);
		expect(service1.did.startsWith("did:key:z6M")).toBe(true);
	});

	it("should generate strictly monotonic nonces across rapid calls", () => {
		const service = new TechnocoreService();
		const n1 = BigInt(service.getNonce());
		const n2 = BigInt(service.getNonce());
		const n3 = BigInt(service.getNonce());

		expect(n2).toBeGreaterThan(n1);
		expect(n3).toBeGreaterThan(n2);
	});

	it("should handle backwards clock jumps monotonically", () => {
		const service = new TechnocoreService();
		const n1 = BigInt(service.getNonce(1000));
		const n2 = BigInt(service.getNonce(1000));
		const n3 = BigInt(service.getNonce(999)); // Backward clock step (NTP/VM resume)

		expect(n2).toBeGreaterThan(n1);
		expect(n3).toBeGreaterThan(n2);
	});

	it("should produce cryptographically valid signatures", () => {
		const service = new TechnocoreService();
		const payload = "technocore\n1725255600000000000\nHello decentralized world";
		const sigUrlSafe = service.signPayload(payload);

		expect(sigUrlSafe).toBeDefined();
		expect(sigUrlSafe.length).toBeGreaterThan(50);

		// Verify signature using Node.js crypto.verify and service's public key
		const sigBytes = Buffer.from(sigUrlSafe, "base64url");
		const isValid = crypto.verify(null, Buffer.from(payload, "utf-8"), service.publicKey, sigBytes);
		expect(isValid).toBe(true);
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
