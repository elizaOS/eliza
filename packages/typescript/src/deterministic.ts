import type { Memory, State } from "./types";
import type { IAgentRuntime } from "./types/runtime";
import { createHash } from "./utils/crypto-compat";

const DEFAULT_TIME_BUCKET_MS = 5 * 60 * 1000;

type SeedPart = string | number | boolean | null | undefined;

function normalizeSeedPart(part: SeedPart): string {
	if (part === null || part === undefined) {
		return "none";
	}
	return String(part);
}

function coerceNonEmptyString(
	value: string | null | undefined,
): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

function hashHex(value: string): string {
	const bytes = createHash("sha256").update(value).digest();
	return toHex(bytes);
}

export function buildDeterministicSeed(parts: readonly SeedPart[]): string {
	return parts.map(normalizeSeedPart).join("|");
}

export function deterministicHex(
	seed: string,
	surface: string,
	length = 16,
): string {
	if (length <= 0) {
		return "";
	}

	let hex = "";
	let counter = 0;
	while (hex.length < length) {
		hex += hashHex(`${seed}|${surface}|${counter}`);
		counter += 1;
	}

	return hex.slice(0, length);
}

export function deterministicInt(
	seed: string,
	surface: string,
	maxExclusive: number,
): number {
	if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) {
		return 0;
	}

	const max = Math.floor(maxExclusive);
	if (max <= 1) {
		return 0;
	}

	const value = Number.parseInt(deterministicHex(seed, surface, 12), 16);
	if (!Number.isFinite(value)) {
		return 0;
	}
	return value % max;
}

export function deterministicPickOne<T>(
	items: readonly T[],
	seed: string,
	surface: string,
): T | undefined {
	if (items.length === 0) {
		return undefined;
	}
	const index = deterministicInt(seed, surface, items.length);
	return items[index];
}

export function deterministicShuffle<T>(
	items: readonly T[],
	seed: string,
	surface = "shuffle",
): T[] {
	const shuffled = [...items];
	for (let i = shuffled.length - 1; i > 0; i -= 1) {
		const j = deterministicInt(seed, `${surface}:${i}`, i + 1);
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	return shuffled;
}

export function deterministicSample<T>(
	items: readonly T[],
	count: number,
	seed: string,
	surface = "sample",
): T[] {
	if (count <= 0 || items.length === 0) {
		return [];
	}
	const shuffled = deterministicShuffle(items, seed, surface);
	return shuffled.slice(0, Math.min(count, shuffled.length));
}

export function deterministicUuid(seed: string, surface: string): string {
	const hex = deterministicHex(seed, surface, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function parseBooleanSetting(
	value: string | number | boolean | null,
): boolean {
	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "number") {
		return value !== 0;
	}

	if (typeof value !== "string") {
		return false;
	}

	const normalized = value.trim().toLowerCase();
	return ["1", "true", "yes", "on", "enabled"].includes(normalized);
}

export function parsePositiveIntegerSetting(
	value: string | number | boolean | null,
	fallback: number,
): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}

	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) {
			return Math.floor(parsed);
		}
	}

	return fallback;
}

interface BuildConversationSeedOptions {
	runtime: Pick<IAgentRuntime, "agentId" | "character">;
	message?: Pick<Memory, "roomId" | "worldId">;
	state?: Pick<State, "data">;
	surface: string;
	bucketMs?: number;
	nowMs?: number;
}

export function buildConversationSeed({
	runtime,
	message,
	state,
	surface,
	bucketMs,
	nowMs = Date.now(),
}: BuildConversationSeedOptions): string {
	const stateRoom = state?.data?.room;
	const stateWorld = state?.data?.world;

	const roomId =
		coerceNonEmptyString(stateRoom?.id) ??
		coerceNonEmptyString(message?.roomId) ??
		"room:none";
	const worldId =
		coerceNonEmptyString(stateWorld?.id) ??
		coerceNonEmptyString(stateRoom?.worldId) ??
		coerceNonEmptyString(message?.worldId) ??
		"world:none";
	const characterId =
		coerceNonEmptyString(runtime.character.id) ??
		coerceNonEmptyString(runtime.agentId) ??
		"agent:none";
	const epochBucket =
		bucketMs && bucketMs > 0 ? Math.floor(nowMs / bucketMs) : 0;

	return buildDeterministicSeed([
		"eliza-prompt-cache-v1",
		worldId,
		roomId,
		characterId,
		epochBucket,
		surface,
	]);
}

interface PromptReferenceDateOptions {
	runtime: Pick<IAgentRuntime, "agentId" | "character" | "getSetting">;
	message: Pick<Memory, "roomId">;
	state: Pick<State, "data">;
	surface: string;
	nowMs?: number;
}

export function getPromptReferenceDate({
	runtime,
	message,
	state,
	surface,
	nowMs = Date.now(),
}: PromptReferenceDateOptions): Date {
	const deterministicEnabled = parseBooleanSetting(
		runtime.getSetting("PROMPT_CACHE_DETERMINISTIC_TIME"),
	);

	if (!deterministicEnabled) {
		return new Date(nowMs);
	}

	const bucketMs = parsePositiveIntegerSetting(
		runtime.getSetting("PROMPT_CACHE_TIME_BUCKET_MS"),
		DEFAULT_TIME_BUCKET_MS,
	);

	const seed = buildConversationSeed({
		runtime,
		message,
		state,
		surface,
		bucketMs,
		nowMs,
	});

	const bucketStart = Math.floor(nowMs / bucketMs) * bucketMs;
	const offset = deterministicInt(seed, "time-offset-ms", bucketMs);
	return new Date(bucketStart + offset);
}
