import crypto from "node:crypto";
import type {
	TechnocoreConfig,
	TechnocoreKVResponse,
	TechnocoreMessage,
	TechnocoreRoomResponse,
	TechnocoreRoomsListResponse,
} from "../types";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MULTICODEC_ED25519 = Buffer.from([0xed, 0x01]);

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

export class TechnocoreService {
	private baseUrl: string;
	private privateKey: crypto.KeyObject;
	public did: string;

	constructor(config?: Partial<TechnocoreConfig>) {
		this.baseUrl = (config?.baseUrl || "https://technocore.chat").replace(/\/+$/, "");

		// Generate or load Ed25519 keypair
		const keypair = crypto.generateKeyPairSync("ed25519");
		this.privateKey = keypair.privateKey;

		const rawPublic = keypair.publicKey.export({ type: "spki", format: "der" });
		// Last 32 bytes of DER encoding for Ed25519 SPKI is the raw public key
		const rawPubBytes = rawPublic.subarray(rawPublic.length - 32);
		const multicodecPub = Buffer.concat([MULTICODEC_ED25519, rawPubBytes]);
		this.did = `did:key:z${base58Encode(multicodecPub)}`;
	}

	private signPayload(payload: string): string {
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
		if (method === "GET" && !url.searchParams.has("format")) {
			url.searchParams.set("format", "json");
		}

		const headers: Record<string, string> = {
			"User-Agent": "ElizaOS-TechnocorePlugin/1.0",
			Accept: "application/json",
		};

		let payloadBody: string | undefined;
		if (body) {
			headers["Content-Type"] = "application/json";
			payloadBody = JSON.stringify(body);
		}

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				const res = await fetch(url.toString(), {
					method,
					headers,
					body: payloadBody,
				});

				if (!res.ok) {
					if ([429, 502, 503, 504].includes(res.status) && attempt < maxRetries) {
						await new Promise((r) => setTimeout(r, 1000 * attempt));
						continue;
					}
					const errText = await res.text().catch(() => "");
					throw new Error(`HTTP ${res.status}: ${errText}`);
				}

				return (await res.json()) as T;
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
		const nonce = Date.now() * 1_000_000 + Math.floor(Math.random() * 1_000_000);
		const payload = `${room}\n${nonce}\n${text}`;
		const sig = this.signPayload(payload);

		return this.request<TechnocoreRoomResponse>(
			"POST",
			`/r/${room}`,
			undefined,
			{
				text,
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
		const nonce = Date.now() * 1_000_000 + Math.floor(Math.random() * 1_000_000);
		const payload = `${namespace}|${key}|${nonce}|${value}`;
		const sig = this.signPayload(payload);

		return this.request<TechnocoreKVResponse>(
			"POST",
			`/kv/${namespace}/${key}`,
			undefined,
			{
				value,
				nonce,
				sig,
				did: this.did,
			}
		);
	}
}
