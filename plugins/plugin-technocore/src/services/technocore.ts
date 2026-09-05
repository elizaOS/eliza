import crypto from "node:crypto";
import { type IAgentRuntime, Service } from "@elizaos/core";
import type {
  TechnocoreConfig,
  TechnocoreKVResponse,
  TechnocoreRoomResponse,
  TechnocoreRoomsListResponse,
} from "../types";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MULTICODEC_ED25519 = Buffer.from([0xed, 0x01]);
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

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

export function assertIdentifier(kind: string, value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid technocore ${kind}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function cleanText(input: string): string {
  return (
    input
      .replace(/[\r\n\t]+/g, " ")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sweeping of invisible/control characters
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const ROOM_STOPWORDS =
  /^(the|a|an|this|that|these|those|my|our|your|any|all|chat|with|for|about|where|when|which|who|whom|whose|why|how|is|are|was|were|be|been|being|to|in|at|from|into|on|of|and|or|but|if)$/i;

/** Deictic in prefix position ("the current room" = here) but valid room names after "room". */
const PREFIX_ONLY_STOPWORDS = /^(current|main|default)$/i;

export function extractTargetRoom(
  text: string,
  defaultRoom: string,
  structuredRoom?: string,
): string {
  if (structuredRoom && /^[a-zA-Z0-9_-]+$/.test(structuredRoom.trim())) {
    return structuredRoom.trim();
  }

  const explicitSlash = text.match(/\/r\/([a-zA-Z0-9_-]+)/i);
  if (explicitSlash?.[1]) {
    return explicitSlash[1];
  }

  // Suffix pattern takes precedence over preceding verbs/tokens (e.g. "read room current" -> "current")
  const suffixMatch = text.match(/\broom\s*[:=]?\s*([a-zA-Z0-9_-]+)/i);
  if (suffixMatch?.[1] && !ROOM_STOPWORDS.test(suffixMatch[1])) {
    return suffixMatch[1];
  }

  // Prefix pattern allows natural trailing room notation (e.g. "read the general room" -> "general")
  const prefixMatch = text.match(/\b([a-zA-Z0-9_-]+)\s+room\b/i);
  if (
    prefixMatch?.[1] &&
    !ROOM_STOPWORDS.test(prefixMatch[1]) &&
    !PREFIX_ONLY_STOPWORDS.test(prefixMatch[1])
  ) {
    return prefixMatch[1];
  }

  return defaultRoom;
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

    const baseUrlSetting = runtime?.getSetting("TECHNOCORE_BASE_URL");
    const privKeySetting = runtime?.getSetting("TECHNOCORE_PRIVATE_KEY_HEX");

    this.baseUrl = (
      config?.baseUrl ||
      (typeof baseUrlSetting === "string" ? baseUrlSetting : undefined) ||
      "https://technocore.chat"
    ).replace(/\/+$/, "");

    const rawKey =
      config?.privateKeyHex ||
      (typeof privKeySetting === "string" ? privKeySetting : undefined);
    const privateKeyHex =
      typeof rawKey === "string" ? rawKey.trim() : undefined;

    if (privateKeyHex && /^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
      const seedBuf = Buffer.from(privateKeyHex, "hex");
      const pkcs8Key = Buffer.concat([PKCS8_ED25519_PREFIX, seedBuf]);
      this.privateKey = crypto.createPrivateKey({
        key: pkcs8Key,
        format: "der",
        type: "pkcs8",
      });
      this.publicKey = crypto.createPublicKey(this.privateKey);
    } else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      this.privateKey = privateKey;
      this.publicKey = publicKey;
    }

    const spki = this.publicKey.export({ format: "der", type: "spki" });
    const rawPubKey = spki.subarray(spki.length - 32);
    const multicodec = Buffer.concat([MULTICODEC_ED25519, rawPubKey]);
    this.did = `did:key:z${base58Encode(multicodec)}`;
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
    const sig = crypto.sign(
      null,
      Buffer.from(payload, "utf-8"),
      this.privateKey,
    );
    return sig.toString("base64url");
  }

  private async request<T>(
    method: string,
    path: string,
    params?: Record<string, string | number | undefined>,
    body?: Record<string, unknown>,
    maxRetries = 3,
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
          if (
            [429, 502, 503, 504].includes(res.status) &&
            attempt < maxRetries
          ) {
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
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.startsWith("HTTP 4") && !errMsg.startsWith("HTTP 429")) {
          throw err;
        }
        if (attempt === maxRetries) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }

    throw new Error("Max request retries exceeded");
  }

  public async postMessage(
    room: string,
    text: string,
  ): Promise<TechnocoreRoomResponse> {
    const validRoom = assertIdentifier("room", room);
    const cleanedText = cleanText(text);
    const nonce = this.getNonce();
    const payload = `${validRoom}|${nonce}|${cleanedText}`;
    const sig = this.signPayload(payload);

    return this.request<TechnocoreRoomResponse>(
      "POST",
      `/r/${validRoom}`,
      undefined,
      {
        text: cleanedText,
        nonce,
        sig,
        did: this.did,
      },
    );
  }

  public async readRoom(
    room: string,
    limit = 25,
    since?: number,
  ): Promise<TechnocoreRoomResponse> {
    const validRoom = assertIdentifier("room", room);
    return this.request<TechnocoreRoomResponse>("GET", `/r/${validRoom}`, {
      limit,
      since,
    });
  }

  public async listRooms(): Promise<TechnocoreRoomsListResponse> {
    return this.request<TechnocoreRoomsListResponse>("GET", "/rooms");
  }

  public async kvGet(
    namespace: string,
    key: string,
  ): Promise<TechnocoreKVResponse> {
    const validNs = assertIdentifier("namespace", namespace);
    const validKey = assertIdentifier("key", key);
    return this.request<TechnocoreKVResponse>(
      "GET",
      `/kv/${validNs}/${validKey}`,
    );
  }

  public async kvSet(
    namespace: string,
    key: string,
    value: string,
  ): Promise<TechnocoreKVResponse> {
    const validNs = assertIdentifier("namespace", namespace);
    const validKey = assertIdentifier("key", key);
    const cleanedValue = cleanText(value);
    const nonce = this.getNonce();
    const payload = `${validNs}|${validKey}|${nonce}|${cleanedValue}`;
    const sig = this.signPayload(payload);

    return this.request<TechnocoreKVResponse>(
      "POST",
      `/kv/${validNs}/${validKey}`,
      undefined,
      {
        value: cleanedValue,
        nonce,
        sig,
        did: this.did,
      },
    );
  }
}
