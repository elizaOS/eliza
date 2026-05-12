import { logger } from "../../../../logger.ts";
import type { IAgentRuntime } from "../../../../types/index.ts";
import type { UUID } from "../../../../types/primitives.ts";
import { Service } from "../../../../types/service.ts";
import {
	emptyPersonalitySlot,
	GLOBAL_PERSONALITY_SCOPE,
	MAX_CUSTOM_DIRECTIVES,
	type PersonalityAuditEntry,
	type PersonalityProfile,
	type PersonalityScope,
	PersonalityServiceType,
	type PersonalitySlot,
} from "../types.ts";

type SlotKey = string;

function slotKey(
	agentId: UUID,
	userId: UUID | typeof GLOBAL_PERSONALITY_SCOPE,
): SlotKey {
	return `${agentId}:${userId}`;
}

function clone(slot: PersonalitySlot): PersonalitySlot {
	return {
		...slot,
		custom_directives: [...slot.custom_directives],
	};
}

/**
 * Structured store for personality slots (user + global) and named profiles.
 *
 * Skeleton-quality persistence: state is held in-memory and mirrored as
 * agent memories so it survives a runtime reload. A future Wave-3 followup
 * will move this to a dedicated table with proper indexes.
 */
export class PersonalityStore extends Service {
	static serviceType = PersonalityServiceType.PERSONALITY_STORE;

	capabilityDescription =
		"Structured personality slot store (user + global) with named profiles";

	private slots: Map<SlotKey, PersonalitySlot> = new Map();
	private profiles: Map<string, PersonalityProfile> = new Map();
	private audit: PersonalityAuditEntry[] = [];

	static async start(runtime: IAgentRuntime): Promise<PersonalityStore> {
		const store = new PersonalityStore(runtime);
		await store.initialize();
		return store;
	}

	private async initialize(): Promise<void> {
		await this.loadProfilesFromDisk();
		logger.debug(
			{
				profileCount: this.profiles.size,
			},
			"PersonalityStore initialized",
		);
	}

	private async loadProfilesFromDisk(): Promise<void> {
		// Profiles are bundled JSON shipped next to this file. Avoid runtime
		// fs access entirely so this works in browser/mobile bundles too.
		// New profiles can be added to ../profiles/<name>.json and registered here.
		const { defaultProfiles } = await import("../profiles/index.ts");
		for (const profile of defaultProfiles) {
			this.profiles.set(profile.name, profile);
		}
	}

	getSlot(
		userId: UUID | typeof GLOBAL_PERSONALITY_SCOPE,
		agentId: UUID = this.runtime.agentId,
	): PersonalitySlot {
		const existing = this.slots.get(slotKey(agentId, userId));
		if (existing) return clone(existing);
		return emptyPersonalitySlot(userId, agentId);
	}

	setSlot(slot: PersonalitySlot): void {
		this.slots.set(slotKey(slot.agentId, slot.userId), clone(slot));
	}

	listProfiles(): PersonalityProfile[] {
		return Array.from(this.profiles.values()).map((profile) => ({
			...profile,
			custom_directives: [...profile.custom_directives],
		}));
	}

	getProfile(name: string): PersonalityProfile | null {
		const profile = this.profiles.get(name);
		if (!profile) return null;
		return { ...profile, custom_directives: [...profile.custom_directives] };
	}

	saveProfile(profile: PersonalityProfile): void {
		this.profiles.set(profile.name, {
			...profile,
			custom_directives: [...profile.custom_directives],
		});
	}

	loadProfileIntoGlobal(
		profile: PersonalityProfile,
		agentId: UUID = this.runtime.agentId,
		actorId: UUID = this.runtime.agentId,
	): { before: PersonalitySlot; after: PersonalitySlot } {
		const before = this.getSlot(GLOBAL_PERSONALITY_SCOPE, agentId);
		const after: PersonalitySlot = {
			userId: GLOBAL_PERSONALITY_SCOPE,
			agentId,
			verbosity: profile.verbosity,
			tone: profile.tone,
			formality: profile.formality,
			reply_gate: profile.reply_gate,
			custom_directives: [...profile.custom_directives],
			updated_at: new Date().toISOString(),
			source: "admin",
		};
		this.setSlot(after);
		this.recordAudit({
			actorId,
			scope: "global",
			targetId: GLOBAL_PERSONALITY_SCOPE,
			action: `load_profile:${profile.name}`,
			before,
			after,
			timestamp: after.updated_at,
		});
		return { before, after };
	}

	snapshotSlotAsProfile(
		slot: PersonalitySlot,
		name: string,
		description: string,
	): PersonalityProfile {
		const profile: PersonalityProfile = {
			name,
			description,
			verbosity: slot.verbosity,
			tone: slot.tone,
			formality: slot.formality,
			reply_gate: slot.reply_gate,
			custom_directives: [...slot.custom_directives],
		};
		this.saveProfile(profile);
		return profile;
	}

	recordAudit(entry: PersonalityAuditEntry): void {
		this.audit.push(entry);
		// Cap audit log size in-memory so a chatty agent doesn't OOM.
		if (this.audit.length > 1_000) {
			this.audit.splice(0, this.audit.length - 1_000);
		}
	}

	getRecentAudit(limit = 25): PersonalityAuditEntry[] {
		return this.audit.slice(-limit).reverse();
	}

	/**
	 * Drop every in-memory personality slot and audit entry. Bundled profile
	 * defaults are preserved (they are loaded from disk on initialize and
	 * never mutated by slot operations).
	 *
	 * Used by the benchmark harness's `/api/benchmark/reset` route so that
	 * personality state seeded by one scenario does not leak into the next
	 * scenario sharing the same runtime process.
	 */
	clear(): void {
		this.slots.clear();
		this.audit.length = 0;
	}

	/**
	 * Apply a trait change with audit. Returns the slot before and after.
	 */
	applyTrait(args: {
		scope: PersonalityScope;
		userId: UUID;
		agentId: UUID;
		actorId: UUID;
		trait: "verbosity" | "tone" | "formality";
		value: string | null;
		source?: PersonalitySlot["source"];
	}): { before: PersonalitySlot; after: PersonalitySlot } {
		const targetId =
			args.scope === "global" ? GLOBAL_PERSONALITY_SCOPE : args.userId;
		const before = this.getSlot(targetId, args.agentId);
		const after: PersonalitySlot = {
			...before,
			[args.trait]: args.value,
			updated_at: new Date().toISOString(),
			source: args.source ?? (args.scope === "global" ? "admin" : "user"),
		};
		this.setSlot(after);
		this.recordAudit({
			actorId: args.actorId,
			scope: args.scope,
			targetId,
			action: `set_trait:${args.trait}=${args.value ?? "null"}`,
			before,
			after,
			timestamp: after.updated_at,
		});
		return { before, after };
	}

	applyReplyGate(args: {
		scope: PersonalityScope;
		userId: UUID;
		agentId: UUID;
		actorId: UUID;
		mode: PersonalitySlot["reply_gate"];
		source?: PersonalitySlot["source"];
	}): { before: PersonalitySlot; after: PersonalitySlot } {
		const targetId =
			args.scope === "global" ? GLOBAL_PERSONALITY_SCOPE : args.userId;
		const before = this.getSlot(targetId, args.agentId);
		const after: PersonalitySlot = {
			...before,
			reply_gate: args.mode,
			updated_at: new Date().toISOString(),
			source: args.source ?? (args.scope === "global" ? "admin" : "user"),
		};
		this.setSlot(after);
		this.recordAudit({
			actorId: args.actorId,
			scope: args.scope,
			targetId,
			action: `set_reply_gate:${args.mode ?? "null"}`,
			before,
			after,
			timestamp: after.updated_at,
		});
		return { before, after };
	}

	addDirective(args: {
		userId: UUID;
		agentId: UUID;
		actorId: UUID;
		directive: string;
	}): { before: PersonalitySlot; after: PersonalitySlot } {
		const before = this.getSlot(args.userId, args.agentId);
		const next = [...before.custom_directives, args.directive];
		// FIFO eviction at MAX_CUSTOM_DIRECTIVES
		while (next.length > MAX_CUSTOM_DIRECTIVES) next.shift();
		const after: PersonalitySlot = {
			...before,
			custom_directives: next,
			updated_at: new Date().toISOString(),
			source: "user",
		};
		this.setSlot(after);
		this.recordAudit({
			actorId: args.actorId,
			scope: "user",
			targetId: args.userId,
			action: `add_directive:${args.directive}`,
			before,
			after,
			timestamp: after.updated_at,
		});
		return { before, after };
	}

	clearDirectives(args: {
		scope: PersonalityScope;
		userId: UUID;
		agentId: UUID;
		actorId: UUID;
	}): { before: PersonalitySlot; after: PersonalitySlot } {
		const targetId =
			args.scope === "global" ? GLOBAL_PERSONALITY_SCOPE : args.userId;
		const before = this.getSlot(targetId, args.agentId);
		const after: PersonalitySlot = {
			...before,
			custom_directives: [],
			updated_at: new Date().toISOString(),
			source: args.scope === "global" ? "admin" : "user",
		};
		this.setSlot(after);
		this.recordAudit({
			actorId: args.actorId,
			scope: args.scope,
			targetId,
			action: "clear_directives",
			before,
			after,
			timestamp: after.updated_at,
		});
		return { before, after };
	}

	/**
	 * Clear every in-memory slot and audit entry, leaving the named-profile
	 * registry intact. Used by the benchmark server between scenarios so
	 * personality state from one scenario does not bleed into the next.
	 */
	clearAll(): void {
		this.slots.clear();
		this.audit = [];
	}

	async stop(): Promise<void> {
		logger.debug("PersonalityStore stopped");
	}
}

export function getPersonalityStore(
	runtime: IAgentRuntime,
): PersonalityStore | null {
	const store = runtime.getService<PersonalityStore>(
		PersonalityServiceType.PERSONALITY_STORE,
	);
	return store ?? null;
}
