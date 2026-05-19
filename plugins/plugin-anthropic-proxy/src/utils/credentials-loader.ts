/**
 * Claude Code credentials loader.
 *
 * Search order (highest precedence first):
 *   1. CLAUDE_MAX_CREDENTIALS_PATH env var (explicit path)
 *   2. CLAUDE_CODE_OAUTH_TOKEN env var (token directly)
 *   3. ~/.claude/.credentials.json
 *   4. ~/.claude/credentials.json
 *
 * Returns null + warning if nothing is found — service will degrade to "off"
 * mode rather than crashing the agent.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OAuthCreds {
	accessToken: string;
	expiresAt: number;
	subscriptionType: string;
	source: "env" | "file";
	path?: string;
}

export interface LoadResult {
	creds: OAuthCreds | null;
	error?: string;
}

/**
 * Decode the JWT exp claim (in seconds) for diagnostics.
 * Returns 0 if not parseable.
 */
function jwtExpiresAt(token: string): number {
	try {
		const parts = token.split(".");
		if (parts.length < 2) return 0;
		const payload = parts[1]!;
		// base64url -> base64
		const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
		const json = Buffer.from(padded, "base64").toString("utf8");
		const parsed = JSON.parse(json) as { exp?: number };
		return typeof parsed.exp === "number" ? parsed.exp * 1000 : 0;
	} catch {
		return 0;
	}
}

export function loadCredentials(opts: {
	credentialsPath?: string;
	envToken?: string;
} = {}): LoadResult {
	if (opts.envToken) {
		return {
			creds: {
				accessToken: opts.envToken,
				expiresAt: Number.POSITIVE_INFINITY,
				subscriptionType: "env-var",
				source: "env",
			},
		};
	}

	const home = homedir();
	const candidates: string[] = [];
	if (opts.credentialsPath) candidates.push(opts.credentialsPath);
	candidates.push(join(home, ".claude", ".credentials.json"));
	candidates.push(join(home, ".claude", "credentials.json"));

	for (const candidate of candidates) {
		const resolved = candidate.startsWith("~")
			? join(home, candidate.slice(1))
			: candidate;
		try {
			if (existsSync(resolved) && statSync(resolved).size > 0) {
				let raw = readFileSync(resolved, "utf8");
				if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
				const parsed = JSON.parse(raw) as {
					claudeAiOauth?: {
						accessToken?: string;
						expiresAt?: number;
						subscriptionType?: string;
					};
				};
				const oauth = parsed.claudeAiOauth;
				if (!oauth || !oauth.accessToken) {
					return {
						creds: null,
						error: `credentials file ${resolved} missing claudeAiOauth.accessToken`,
					};
				}
				return {
					creds: {
						accessToken: oauth.accessToken,
						expiresAt: oauth.expiresAt ?? jwtExpiresAt(oauth.accessToken),
						subscriptionType: oauth.subscriptionType ?? "unknown",
						source: "file",
						path: resolved,
					},
				};
			}
		} catch (e) {
			return {
				creds: null,
				error: `failed to read ${resolved}: ${(e as Error).message}`,
			};
		}
	}

	return {
		creds: null,
		error: `claude credentials not found, searched: ${candidates.join(", ")}. Run 'claude auth login' to authenticate.`,
	};
}
