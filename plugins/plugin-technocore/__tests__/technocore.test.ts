import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { TechnocoreService, cleanText } from "../src/services/technocore";
import { postMessageAction } from "../src/actions/postMessage";
import { readRoomAction } from "../src/actions/readRoom";
import { listRoomsAction } from "../src/actions/listRooms";
import { kvSetAction, kvGetAction } from "../src/actions/kvStorage";
import { technocorePlugin } from "../src/index";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(str: string): Buffer {
	let num = 0n;
	for (let i = 0; i < str.length; i++) {
		const idx = BASE58_ALPHABET.indexOf(str[i]);
		if (idx === -1) throw new Error(`Invalid base58 character ${str[i]}`);
		num = num * 58n + BigInt(idx);
	}
	const hex = num.toString(16);
	const hexPadded = hex.length % 2 === 0 ? hex : `0${hex}`;
	let bytes = Buffer.from(hexPadded, "hex");

	let leadingZeroes = 0;
	for (let i = 0; i < str.length && str[i] === "1"; i++) {
		leadingZeroes++;
	}
	if (leadingZeroes > 0) {
		bytes = Buffer.concat([Buffer.alloc(leadingZeroes, 0), bytes]);
	}
	return bytes;
}

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

	it("should decode DID key and verify pipe-delimited payload signature against decoded public key", () => {
		const service = new TechnocoreService();
		const room = "technocore";
		const rawText = "Hello\r\n\tdecentralized \u200Bworld!";
		const normalizedText = cleanText(rawText);
		const nonce = service.getNonce();
		const canonicalPayload = `${room}|${nonce}|${normalizedText}`;
		const sigUrlSafe = service.signPayload(canonicalPayload);

		// Decode the DID according to standard W3C did:key Ed25519 multicodec
		expect(service.did.startsWith("did:key:z")).toBe(true);
		const multicodec = base58Decode(service.did.slice(9));
		// Multicodec 0xed01 prefix (2 bytes) + 32-byte Ed25519 raw public key
		expect(multicodec[0]).toBe(0xed);
		expect(multicodec[1]).toBe(0x01);
		const rawPubKey = multicodec.subarray(2);
		expect(rawPubKey.length).toBe(32);

		// Construct SPKI from raw 32 bytes and verify
		const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
		const fullSpki = Buffer.concat([spkiPrefix, rawPubKey]);
		const pubKeyObj = crypto.createPublicKey({ key: fullSpki, format: "der", type: "spki" });

		const sigBytes = Buffer.from(sigUrlSafe, "base64url");
		const isValid = crypto.verify(null, Buffer.from(canonicalPayload, "utf-8"), pubKeyObj, sigBytes);
		expect(isValid).toBe(true);
	});

	it("should normalize text and sweep hostile/invisible characters cleanly", () => {
		const input = "  Line 1\r\nLine 2\t\twith   extra   spaces\u200B\uFEFF\u0000  ";
		const cleaned = cleanText(input);
		expect(cleaned).toBe("Line 1 Line 2 with extra spaces");
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

	it("should fail-closed when TechnocoreService is not registered in runtime", async () => {
		const mockRuntimeNoService: any = {
			getService: () => undefined,
			getSetting: () => undefined,
		};
		const msg: any = { content: { text: "post to room test" } };

		const resPost = await postMessageAction.handler(mockRuntimeNoService, msg);
		expect(resPost.success).toBe(false);
		expect(resPost.error).toContain("TechnocoreService is not registered");

		const resRead = await readRoomAction.handler(mockRuntimeNoService, msg);
		expect(resRead.success).toBe(false);
		expect(resRead.error).toContain("TechnocoreService is not registered");

		const resList = await listRoomsAction.handler(mockRuntimeNoService, msg);
		expect(resList.success).toBe(false);
		expect(resList.error).toContain("TechnocoreService is not registered");

		const resKvSet = await kvSetAction.handler(mockRuntimeNoService, msg);
		expect(resKvSet.success).toBe(false);
		expect(resKvSet.error).toContain("TechnocoreService is not registered");

		const resKvGet = await kvGetAction.handler(mockRuntimeNoService, msg);
		expect(resKvGet.success).toBe(false);
		expect(resKvGet.error).toContain("TechnocoreService is not registered");
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

	it("should strictly reject invalid identifiers in postMessage, readRoom, kvSet, and kvGet", async () => {
		const service = new TechnocoreService();
		const invalidIds = ["a|b", "a?b", "a#b", "a/b", "a b", "a\nb", ""];

		for (const invalid of invalidIds) {
			await expect(service.postMessage(invalid, "hello")).rejects.toThrow(/Invalid technocore room/);
			await expect(service.readRoom(invalid)).rejects.toThrow(/Invalid technocore room/);
			await expect(service.kvSet(invalid, "key", "val")).rejects.toThrow(/Invalid technocore namespace/);
			await expect(service.kvSet("ns", invalid, "val")).rejects.toThrow(/Invalid technocore key/);
			await expect(service.kvGet(invalid, "key")).rejects.toThrow(/Invalid technocore namespace/);
			await expect(service.kvGet("ns", invalid)).rejects.toThrow(/Invalid technocore key/);
		}
	});

	it("should maintain exact URL path alignment across write and read round-trips without aliasing", async () => {
		const originalFetch = globalThis.fetch;
		const requestedUrls: string[] = [];

		globalThis.fetch = (async (url: string | URL | Request) => {
			requestedUrls.push(url.toString());
			return {
				ok: true,
				status: 200,
				headers: new Headers({ "content-type": "application/json" }),
				json: async () => ({ success: true }),
				text: async () => JSON.stringify({ success: true }),
			} as Response;
		}) as typeof fetch;

		try {
			const service = new TechnocoreService();
			const ns = "agent-memory-v1";
			const key = "checkpoint_001";
			const room = "general-room_42";

			await service.kvSet(ns, key, "some_value");
			await service.kvGet(ns, key);

			const writeKvUrl = new URL(requestedUrls[0]);
			const readKvUrl = new URL(requestedUrls[1]);
			expect(writeKvUrl.pathname).toBe(`/kv/${ns}/${key}`);
			expect(readKvUrl.pathname).toBe(`/kv/${ns}/${key}`);
			expect(writeKvUrl.pathname).toBe(readKvUrl.pathname);

			await service.postMessage(room, "broadcast text");
			await service.readRoom(room);

			const writeRoomUrl = new URL(requestedUrls[2]);
			const readRoomUrl = new URL(requestedUrls[3]);
			expect(writeRoomUrl.pathname).toBe(`/r/${room}`);
			expect(readRoomUrl.pathname).toBe(`/r/${room}`);
			expect(writeRoomUrl.pathname).toBe(readRoomUrl.pathname);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
