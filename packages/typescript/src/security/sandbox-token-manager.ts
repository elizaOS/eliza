/**
 * Sandbox secret token manager.
 *
 * Maps real secrets to opaque `stok_` prefixed tokens. Plugins see tokens;
 * the fetch proxy resolves them to real values at the network boundary.
 */

import { v4 as uuidv4 } from "uuid";

export const SANDBOX_TOKEN_PREFIX = "stok_";

export interface SecretTokenMetadata {
	settingKey: string;
	secretType: "api_key" | "oauth_token" | "password" | "private_key" | "other";
	createdAt: number;
	owner?: string;
}

interface TokenEntry {
	token: string;
	realValue: string;
	metadata: SecretTokenMetadata;
}

export class SandboxTokenManager {
	private tokenToEntry = new Map<string, TokenEntry>();
	private realValueToToken = new Map<string, string>();
	private settingKeyToToken = new Map<string, string>();

	/** Register a secret, returning its stable token. Idempotent per key. */
	registerSecret(
		settingKey: string,
		realValue: string,
		metadata?: Partial<SecretTokenMetadata>,
	): string {
		const existingToken = this.settingKeyToToken.get(settingKey);
		if (existingToken) {
			const entry = this.tokenToEntry.get(existingToken);
			if (entry) {
				if (entry.realValue === realValue) return existingToken;
				// Value rotated — update mapping
				this.realValueToToken.delete(entry.realValue);
				entry.realValue = realValue;
				this.realValueToToken.set(realValue, existingToken);
				return existingToken;
			}
		}

		const token = `${SANDBOX_TOKEN_PREFIX}${uuidv4()}`;
		const entry: TokenEntry = {
			token,
			realValue,
			metadata: {
				settingKey,
				secretType: metadata?.secretType ?? inferSecretType(settingKey),
				createdAt: Date.now(),
				owner: metadata?.owner,
			},
		};

		this.tokenToEntry.set(token, entry);
		this.realValueToToken.set(realValue, token);
		this.settingKeyToToken.set(settingKey, token);
		return token;
	}

	resolveToken(token: string): string | null {
		return this.tokenToEntry.get(token)?.realValue ?? null;
	}

	getTokenForKey(settingKey: string): string | null {
		return this.settingKeyToToken.get(settingKey) ?? null;
	}

	getTokenForValue(realValue: string): string | null {
		return this.realValueToToken.get(realValue) ?? null;
	}

	getMetadata(token: string): SecretTokenMetadata | null {
		return this.tokenToEntry.get(token)?.metadata ?? null;
	}

	/** Replace tokens → real values (outbound). */
	detokenizeString(input: string): string {
		if (!input || !input.includes(SANDBOX_TOKEN_PREFIX)) return input;
		let result = input;
		for (const [token, entry] of this.tokenToEntry) {
			if (result.includes(token)) {
				result = replaceAll(result, token, entry.realValue);
			}
		}
		return result;
	}

	/** Replace real values → tokens (inbound). Longest-first to avoid partial matches. */
	tokenizeString(input: string): string {
		if (!input) return input;
		let result = input;
		const entries = [...this.realValueToToken.entries()].sort(
			([a], [b]) => b.length - a.length,
		);
		for (const [realValue, token] of entries) {
			if (result.includes(realValue)) {
				result = replaceAll(result, realValue, token);
			}
		}
		return result;
	}

	static isToken(value: string): boolean {
		return typeof value === "string" && value.startsWith(SANDBOX_TOKEN_PREFIX);
	}

	get size(): number {
		return this.tokenToEntry.size;
	}

	clear(): void {
		this.tokenToEntry.clear();
		this.realValueToToken.clear();
		this.settingKeyToToken.clear();
	}

	listKeys(): string[] {
		return [...this.settingKeyToToken.keys()];
	}
}

function inferSecretType(key: string): SecretTokenMetadata["secretType"] {
	const u = key.toUpperCase();
	if (u.includes("PRIVATE_KEY") || u.includes("PRIVKEY")) return "private_key";
	if (u.includes("OAUTH") || u.includes("REFRESH_TOKEN")) return "oauth_token";
	if (u.includes("PASSWORD") || u.includes("PASSWD")) return "password";
	if (
		u.includes("API_KEY") ||
		u.includes("APIKEY") ||
		u.includes("SECRET") ||
		u.includes("TOKEN")
	)
		return "api_key";
	return "other";
}

function replaceAll(str: string, search: string, replacement: string): string {
	const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return str.replace(new RegExp(escaped, "g"), replacement);
}
