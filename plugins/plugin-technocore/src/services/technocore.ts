import crypto from "node:crypto";
import { type IAgentRuntime, Service } from "@elizaos/core";
import type {
	TechnocoreConfig,
	TechnocoreKVResponse,
	TechnocoreRoomResponse,
	TechnocoreRoomsListResponse,
} from "../types";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MULTICODEC_ED25519 = Buffer.from([0xed, 0x01]);
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function base58Encode(buffer: Buffer): string {
	let num = BigInt(`0x${buffer.toString("hex")}`);
	let encoded = "";
	while (num > 0n) {
		const rem = Number(num % 58n);
		num = num / 58n;
		encoded = BASE58_ALPHABET[rem] + encoded;
	}
	for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
		encoded = `1${encoded}`;
	}
	return encoded;
}

export function cleanText(input: string): string {
	return input
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export class TechnocoreService extends Service {
	static override serviceType = "technocore";
	capabilityDescription =
		"Technocore decentralized agent-to-agent communication, room discovery, and cryptographic memory protocol";

	private baseUrl: string;
	private privateKey: crypto.KeyObject;
	public publicKey: crypto.KeyObject;
	public did: string;
	private lastMs = 0;
	private seq = 0;

	constructor(runtime?: IAgentRuntime, config?: Partial<TechnocoreConfig>) {
		super(runtime);

		const settingUrl = runtime?.getSetting?.("TECHNOCORE_BASE_URL") as string | undefined;
		this.baseUrl = (config?.baseUrl || settingUrl || "https://technocore.chat").replace(/\/+$/, "");

		const privateKeySetting =
			(runtime?.getSetting?.("TECHNOCORE_PRIVATE_KEY_HEX") as string | undefined) ||
			(runtime?.getSetting?.("TECHNOCORE_PRIVATE_KEY") as string | undefined) ||
			config?.privateKeyHex;

		if (privateKeySetting && /^[0-9a-fA-F]{64}$/.test(privateKeySetting.trim())) {
			// Deterministically load from 32-byte Ed25519 seed hex
			const seed = Buffer.from(privateKeySetting.trim(), "hex");
			const pkcs8Der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
			this.privateKey = crypto.createPrivateKey({
				key: pkcs8Der,
				format: "der",
				type: "pkcs8",
			});
			this.publicKey = crypto.createPublicKey(this.privateKey);
		} else {
			// Generate fresh persistent keypair for this service instance
			const keypair = crypto.generateKeyPairSync("ed25519");
			this.privateKey = keypair.privateKey;
			this.publicKey = keypair.publicKey;
		}

		const rawPublic = this.publicKey.export({ type: "spki", format: "der" });
		const rawPubBytes = rawPublic.subarray(rawPublic.length - 32);
		const multicodecPub = Buffer.concat([MULTICODEC_ED25519, rawPubBytes]);
		this.did = `did:key:z${base58Encode(multicodecPub)}`;
	}

	public override async stop(): Promise<void> {
		// Cleanup service resources on shutdown
	}

	public getNonce(nowMs: number = Date.now()): string {
		if (nowMs <= this.lastMs) {
			this.seq++;
		} else {
			this.lastMs = nowMs;
			this.seq = 0;
		}
		return (BigInt(this.lastMs) * 1_000_000n + BigInt(this.seq)).toString();
	}

	public signPayload(payload: string): string {
		const sig = crypto.sign(null, Buffer.from(payload, "utf-8"), this.privateKey);
		return sig.toString("base64url").replace(/=+$/, "");
	}

	private async request<T>(
		method: string,
		path: string,
		params?: Record<string, string | number | undefined>,
		body?: Record<string, unknown>,
		maxRetries = 3
	): Promise<T> {
		const url = new URL(`${this.baseUrl}${path}`);
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				if (v !== undefined) {
					url.searchParams.set(k, String(v));
				}
			}
		}
		if (!url.searchParams.has("format")) {
			url.searchParams.set("format", "json");
		}

		const headers: Record<string, string> = {
			"User-Agent": "elizaOS-TechnocorePlugin/1.0",
			Accept: "application/json, text/plain, */*",
		};

		let payloadBody: string | undefined;
		if (body) {
			headers["Content-Type"] = "application/json";
			payloadBody = JSON.stringify(body);
		}

		const init: RequestInit = { method, headers };
		if (payloadBody !== undefined) {
			init.body = payloadBody;
		}

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				const res = await fetch(url.toString(), init);

				if (!res.ok) {
					if ([429, 502, 503, 504].includes(res.status) && attempt < maxRetries) {
						await new Promise((r) => setTimeout(r, 1000 * attempt));
						continue;
					}
					const errText = await res.text().catch(() => "");
					throw new Error(`HTTP ${res.status}: ${errText}`);
				}

				const contentType = res.headers.get("content-type") || "";
				if (contentType.includes("application/json")) {
					return (await res.json()) as T;
				}
				const textResp = await res.text();
				try {
					return JSON.parse(textResp) as T;
				} catch {
					return { success: true, message: textResp } as unknown as T;
				}
			} catch (err) {
				if (attempt === maxRetries) {
					throw err;
				}
				await new Promise((r) => setTimeout(r, 800 * attempt));
			}
		}

		throw new Error("Max request retries exceeded");
	}

	public async postMessage(room: string, text: string): Promise<TechnocoreRoomResponse> {
		const cleanRoom = cleanText(room).replaceAll("|", "");
		const cleanedText = cleanText(text);
		const nonce = this.getNonce();
		const payload = `${cleanRoom}|${nonce}|${cleanedText}`;
		const sig = this.signPayload(payload);

		return this.request<TechnocoreRoomResponse>(
			"POST",
			`/r/${cleanRoom}`,
			undefined,
			{
				text: cleanedText,
				nonce,
				sig,
				did: this.did,
			}
		);
	}

	public async readRoom(
		room: string,
		limit = 25,
		since?: number
	): Promise<TechnocoreRoomResponse> {
		return this.request<TechnocoreRoomResponse>("GET", `/r/${room}`, { limit, since });
	}

	public async listRooms(): Promise<TechnocoreRoomsListResponse> {
		return this.request<TechnocoreRoomsListResponse>("GET", "/rooms");
	}

	public async kvGet(namespace: string, key: string): Promise<TechnocoreKVResponse> {
		return this.request<TechnocoreKVResponse>("GET", `/kv/${namespace}/${key}`);
	}

	public async kvSet(
		namespace: string,
		key: string,
		value: string
	): Promise<TechnocoreKVResponse> {
		const cleanNs = cleanText(namespace).replaceAll("|", "");
		const cleanKey = cleanText(key).replaceAll("|", "");
		const cleanedValue = cleanText(value);
		const nonce = this.getNonce();
		const payload = `${cleanNs}|${cleanKey}|${nonce}|${cleanedValue}`;
		const sig = this.signPayload(payload);

		return this.request<TechnocoreKVResponse>(
			"POST",
			`/kv/${cleanNs}/${cleanKey}`,
			undefined,
			{
				value: cleanedValue,
				nonce,
				sig,
				did: this.did,
			}
		);
	}
}
