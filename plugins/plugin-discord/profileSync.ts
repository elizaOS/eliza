/**
 * Syncs the bot's Discord username and avatar on startup from the character
 * profile, gated by `DISCORD_SYNC_PROFILE`. Hashes the avatar bytes to skip
 * uploads when nothing changed.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { ElizaError, resolveStateDir, resolveUserPath } from "@elizaos/core";
import type { ClientUser } from "discord.js";
import type { DiscordSettings } from "./types";

const MAX_PROFILE_AVATAR_BYTES = 8 * 1024 * 1024;
const PROFILE_SYNC_STATE_FILE = "discord-profile-sync.v1.json";
const DEFAULT_DISCORD_PROFILE_AVATAR = "/avatars/eliza.png";

type PersistedDiscordProfileSyncState = {
	avatarHash?: string;
	username?: string;
};

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

/**
 * `errno` codes that mean the probed path genuinely is not there: nothing at
 * the path (`ENOENT`) or a parent component that is not a directory
 * (`ENOTDIR`). Any other code — `EACCES`, `EISDIR`, `EIO`, `ELOOP`, `EMFILE` —
 * describes a file the probe could not READ, not a file that does not exist,
 * and must never be summarized as absence.
 */
const ABSENT_PATH_ERROR_CODES = new Set(["ENOENT", "ENOTDIR"]);

function pathProbeErrorCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
	return typeof code === "string" ? code : "unknown";
}

async function readAvatarBytesFromLocalCandidates(
	source: string,
): Promise<Buffer> {
	const candidates = buildLocalAvatarPathCandidates(source);
	const failures: Array<{ candidate: string; error: unknown }> = [];
	for (const candidate of candidates) {
		try {
			return await fs.readFile(candidate);
		} catch (error) {
			// error-policy:J2 every probe failure is retained and rethrown below as
			// one typed error carrying the first cause. Dropping them here would let
			// an unreadable-but-present file be reported as nonexistent.
			failures.push({ candidate, error });
		}
	}

	if (candidates.length === 0) {
		throw new ElizaError(
			`Discord profile avatar source resolved to no candidate path: ${source}`,
			{
				code: "DISCORD_PROFILE_AVATAR_UNRESOLVED",
				context: { source },
			},
		);
	}

	// Report the SOURCE and every path tried, not one arbitrary candidate's
	// ENOENT. Rethrowing the last miss named a single file the reader then went
	// hunting for — the live warning read `ENOENT ... open
	// '<repo>/public/avatars/eliza.png'`, which describes neither the real
	// input (`/avatars/eliza.png`, a web path served from blob storage, with no
	// local file anywhere) nor the fact that several roots were probed.
	//
	// Aggregating is only honest when every probe actually missed. A candidate
	// that failed for any other reason EXISTS as far as this loop can tell, so
	// reporting it as nonexistence would fabricate the diagnosis this function
	// was written to stop fabricating — and would bury the EACCES/EIO that is
	// the real fault. Split the two outcomes and keep the underlying cause.
	const tried = candidates.join(", ");
	const unreadable = failures.filter(
		({ error }) => !ABSENT_PATH_ERROR_CODES.has(pathProbeErrorCode(error)),
	);
	const firstUnreadable = unreadable[0];
	if (firstUnreadable) {
		throw new ElizaError(
			`Unable to read Discord profile avatar source "${source}" — ${unreadable.length} of ${candidates.length} candidate path(s) failed for a reason other than absence (first: ${pathProbeErrorCode(firstUnreadable.error)} at ${firstUnreadable.candidate}); tried: ${tried}`,
			{
				code: "DISCORD_PROFILE_AVATAR_UNREADABLE",
				context: {
					source,
					candidates,
					unreadable: unreadable.map(({ candidate, error }) => ({
						candidate,
						code: pathProbeErrorCode(error),
					})),
				},
				cause: firstUnreadable.error,
			},
		);
	}

	throw new ElizaError(
		`Unable to resolve Discord profile avatar source "${source}" — none of ${candidates.length} candidate path(s) exist: ${tried}`,
		{
			code: "DISCORD_PROFILE_AVATAR_NOT_FOUND",
			context: { source, candidates },
			cause: failures[0]?.error,
		},
	);
}

async function loadDiscordProfileAvatarBytes(
	source: string,
	runtime: IAgentRuntime,
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
			const fetchImpl = runtime.fetch ?? globalThis.fetch;
			if (typeof fetchImpl !== "function") {
				return null;
			}
			const response = await fetchImpl(trimmed, {
				headers: { Accept: "image/*" },
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const contentType = response.headers.get("content-type");
			if (!contentType?.toLowerCase().startsWith("image/")) {
				throw new Error(
					`Expected image content-type, got ${contentType ?? "unknown"}`,
				);
			}
			bytes = Buffer.from(await response.arrayBuffer());
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
			runtime,
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
