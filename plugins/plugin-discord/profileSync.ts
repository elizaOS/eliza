/**
 * Syncs the bot's Discord username and avatar on startup from the character
 * profile, gated by `DISCORD_SYNC_PROFILE`. Hashes the avatar bytes to skip
 * uploads when nothing changed.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FetchMediaOptions, IAgentRuntime } from "@elizaos/core";
import {
	ElizaError,
	fetchRemoteMedia,
	resolveStateDir,
	resolveUserPath,
} from "@elizaos/core";
import type { ClientUser } from "discord.js";
import type { DiscordSettings } from "./types";

const MAX_PROFILE_AVATAR_BYTES = 8 * 1024 * 1024;
const PROFILE_AVATAR_FETCH_TIMEOUT_MS = 15_000;
const PROFILE_SYNC_STATE_FILE = "discord-profile-sync.v1.json";
const DEFAULT_DISCORD_PROFILE_AVATAR = "/avatars/eliza.png";

type PersistedDiscordProfileSyncState = {
	avatarHash?: string;
	username?: string;
};

/** Deterministic transport seam for profile-sync tests. Production callers omit it. */
export type DiscordProfileSyncOptions = Pick<
	FetchMediaOptions,
	"fetchImpl" | "lookupFn" | "pinnedFetchImpl"
>;

function resolveProfileSyncStatePath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return path.join(resolveStateDir(env), "cache", PROFILE_SYNC_STATE_FILE);
}

async function readPersistedProfileSyncState(
	env: NodeJS.ProcessEnv = process.env,
): Promise<PersistedDiscordProfileSyncState> {
	try {
		const raw = await fs.readFile(resolveProfileSyncStatePath(env), "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return {
			...(typeof parsed.avatarHash === "string"
				? { avatarHash: parsed.avatarHash }
				: {}),
			...(typeof parsed.username === "string"
				? { username: parsed.username }
				: {}),
		};
	} catch {
		return {};
	}
}

async function writePersistedProfileSyncState(
	state: PersistedDiscordProfileSyncState,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const statePath = resolveProfileSyncStatePath(env);
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(statePath, JSON.stringify(state, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
}

function normalizeDesiredDiscordName(
	runtime: IAgentRuntime,
	settings: DiscordSettings,
): string | undefined {
	const configured = settings.profileName?.trim();
	if (configured) {
		return configured;
	}

	const characterName = runtime.character.name?.trim();
	if (characterName) {
		return characterName;
	}

	const characterUserName = runtime.character.username?.trim();
	return characterUserName || undefined;
}

function readNestedOptionalString(
	value: unknown,
	pathSegments: string[],
): string | undefined {
	let cursor: unknown = value;
	for (const segment of pathSegments) {
		if (!cursor || typeof cursor !== "object") {
			return undefined;
		}
		cursor = (cursor as Record<string, unknown>)[segment];
	}

	return typeof cursor === "string" && cursor.trim().length > 0
		? cursor.trim()
		: undefined;
}

function normalizeDesiredDiscordAvatarSource(
	runtime: IAgentRuntime,
	settings: DiscordSettings,
): string | undefined {
	const configured = settings.profileAvatar?.trim();
	if (configured) {
		return configured;
	}

	const character = runtime.character as Record<string, unknown> | undefined;
	const fromIdentity =
		readNestedOptionalString(character, ["identity", "avatar"]) ??
		readNestedOptionalString(character, ["settings", "identity", "avatar"]);
	if (fromIdentity) {
		return fromIdentity;
	}

	const fromCharacter =
		readNestedOptionalString(character, ["avatar"]) ??
		readNestedOptionalString(character, ["settings", "avatar"]);
	if (fromCharacter) {
		return fromCharacter;
	}

	return DEFAULT_DISCORD_PROFILE_AVATAR;
}

function extractDataUriPayload(source: string): Buffer | null {
	const match = source.match(/^data:image\/[^;]+;base64,([a-z0-9+/=]+)$/i);
	if (!match) {
		return null;
	}
	return Buffer.from(match[1], "base64");
}

function buildLocalAvatarPathCandidates(source: string): string[] {
	const candidates = new Set<string>();
	const trimmed = source.trim();
	if (!trimmed) {
		return [];
	}

	candidates.add(resolveUserPath(trimmed));

	const normalized = trimmed.replace(/\\/g, "/");
	const withoutLeadingSlash = normalized.replace(/^\/+/, "");
	if (!withoutLeadingSlash) {
		return [...candidates];
	}

	const repoRoot = process.cwd();
	const publicRoots = [
		path.join(repoRoot, "cloud", "public"),
		path.join(repoRoot, "apps", "web", "public"),
		path.join(repoRoot, "public"),
	];

	for (const publicRoot of publicRoots) {
		candidates.add(path.join(publicRoot, withoutLeadingSlash));
		if (!withoutLeadingSlash.startsWith("avatars/")) {
			candidates.add(path.join(publicRoot, "avatars", withoutLeadingSlash));
		}
	}

	return [...candidates];
}

async function readAvatarBytesFromLocalCandidates(
	source: string,
): Promise<Buffer> {
	const candidates = buildLocalAvatarPathCandidates(source);
	for (const [candidateIndex, candidate] of candidates.entries()) {
		try {
			return await fs.readFile(candidate);
		} catch (error) {
			const fsCode =
				error instanceof Error &&
				"code" in error &&
				typeof error.code === "string"
					? error.code
					: undefined;
			if (fsCode === "ENOENT" || fsCode === "ENOTDIR") {
				// error-policy:J3 these codes mean this candidate is absent; probing
				// the next declared root is the intended resolution algorithm.
				continue;
			}

			// error-policy:J2 a present-but-unreadable candidate is not a miss.
			// Preserve its machine-readable cause without copying the OS message,
			// which can contain a user path or other sensitive local details.
			const sanitizedCause = Object.assign(
				new Error(
					fsCode
						? `Filesystem read failed (${fsCode}).`
						: "Filesystem read failed.",
				),
				fsCode ? { code: fsCode } : {},
			);
			throw new ElizaError(
				"A Discord profile avatar candidate could not be read.",
				{
					code: "DISCORD_PROFILE_AVATAR_READ_FAILED",
					cause: sanitizedCause,
					context: {
						fsCode: fsCode ?? "UNKNOWN",
						candidateIndex,
						candidateCount: candidates.length,
					},
					severity: "ephemeral",
				},
			);
		}
	}

	throw new ElizaError(
		`Discord profile avatar was not found in ${candidates.length} local candidate path(s).`,
		{
			code: "DISCORD_PROFILE_AVATAR_NOT_FOUND",
			context: { candidateCount: candidates.length },
			severity: "ephemeral",
		},
	);
}

async function loadDiscordProfileAvatarBytes(
	source: string,
	fetchOptions: DiscordProfileSyncOptions,
): Promise<{ bytes: Buffer; hash: string } | null> {
	const trimmed = source.trim();
	if (!trimmed) {
		return null;
	}

	let bytes: Buffer | null = extractDataUriPayload(trimmed);
	if (!bytes) {
		let remoteUrl: URL | null = null;
		try {
			const parsedUrl = new URL(trimmed);
			if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
				remoteUrl = parsedUrl;
			}
		} catch {
			// error-policy:J3 the avatar source is untrusted input that may be a data URI,
			// URL, or local path; a URL parse failure just means "not a remote URL" and
			// falls through to the local-candidate reader below — not an error.
		}

		if (remoteUrl) {
			const fetched = await fetchRemoteMedia({
				url: trimmed,
				maxBytes: MAX_PROFILE_AVATAR_BYTES,
				timeoutMs: PROFILE_AVATAR_FETCH_TIMEOUT_MS,
				requiredContentTypePrefix: "image/",
				rejectContentEncoding: true,
				...fetchOptions,
			});
			bytes = fetched.buffer;
		} else {
			bytes = await readAvatarBytesFromLocalCandidates(trimmed);
		}
	}

	if (!bytes || bytes.length === 0) {
		return null;
	}
	if (bytes.length > MAX_PROFILE_AVATAR_BYTES) {
		throw new Error(
			`Discord profile avatar exceeds ${MAX_PROFILE_AVATAR_BYTES} bytes`,
		);
	}

	return {
		bytes,
		hash: createHash("sha256").update(bytes).digest("hex"),
	};
}

export async function syncDiscordClientProfile(
	runtime: IAgentRuntime,
	clientUser: Pick<ClientUser, "username"> & {
		setAvatar?: (avatar: Buffer | string | null) => Promise<unknown>;
		setUsername?: (username: string) => Promise<unknown>;
	},
	settings: DiscordSettings,
	options: DiscordProfileSyncOptions = {},
): Promise<void> {
	if (settings.syncProfile === false) {
		return;
	}

	const desiredName = normalizeDesiredDiscordName(runtime, settings);
	const desiredAvatarSource = normalizeDesiredDiscordAvatarSource(
		runtime,
		settings,
	);
	if (!desiredName && !desiredAvatarSource) {
		return;
	}

	const persisted = await readPersistedProfileSyncState();
	const nextState: PersistedDiscordProfileSyncState = { ...persisted };
	let stateChanged = false;

	if (desiredName) {
		if (persisted.username !== desiredName) {
			if (clientUser.username !== desiredName) {
				if (typeof clientUser.setUsername === "function") {
					await clientUser.setUsername(desiredName);
					runtime.logger.info(
						{
							src: "plugin:discord",
							agentId: runtime.agentId,
							discordProfileName: desiredName,
						},
						"Synchronized Discord bot username from connector settings",
					);
				}
			}
			nextState.username = desiredName;
			stateChanged = true;
		}
	}

	if (desiredAvatarSource) {
		const avatar = await loadDiscordProfileAvatarBytes(
			desiredAvatarSource,
			options,
		);
		if (avatar && persisted.avatarHash !== avatar.hash) {
			if (typeof clientUser.setAvatar === "function") {
				await clientUser.setAvatar(avatar.bytes);
				runtime.logger.info(
					{
						src: "plugin:discord",
						agentId: runtime.agentId,
					},
					"Synchronized Discord bot avatar from connector settings",
				);
			}
			nextState.avatarHash = avatar.hash;
			stateChanged = true;
		}
	}

	if (stateChanged) {
		await writePersistedProfileSyncState(nextState);
	}
}
