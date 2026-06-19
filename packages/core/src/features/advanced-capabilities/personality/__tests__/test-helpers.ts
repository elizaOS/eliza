import type {
	Character,
	Content,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../../../types/index.ts";
import { PersonalityStore } from "../services/personality-store.ts";

let _seq = 0;
function nextUuid(): UUID {
	_seq += 1;
	const hex = _seq.toString(16).padStart(8, "0");
	return `00000000-0000-4000-8000-${hex}0000000000`.slice(0, 36) as UUID;
}

export interface FakeRuntimeOptions {
	agentId?: UUID;
	character?: Partial<Character>;
	owner?: UUID;
	admins?: UUID[];
}

/**
 * Minimal IAgentRuntime stub for personality unit tests. Uses an in-memory
 * memory store and a PersonalityStore instance — enough for action handlers,
 * provider, and reply-gate / verbosity helpers to exercise the real code.
 */
export interface FakeRuntime {
	runtime: IAgentRuntime;
	store: PersonalityStore;
	memories: Map<string, Memory[]>;
}

export function makeFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
	const agentId = options.agentId ?? nextUuid();
	const owner = options.owner ?? null;
	const admins = new Set<UUID>(options.admins ?? []);

	const character: Character = {
		name: "TestAgent",
		bio: ["test"],
		messageExamples: [],
		postExamples: [],
		topics: [],
		adjectives: [],
		knowledge: [],
		plugins: [],
		secrets: {},
		settings: {},
		...options.character,
	} as Character;

	const memories = new Map<string, Memory[]>();

	const services = new Map<string, unknown>();
	const runtime = {
		agentId,
		character,
		logger: {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
			trace: () => {},
		},
		getService<T = unknown>(name: string): T | null {
			return (services.get(name) as T) ?? null;
		},
		registerService(name: string, service: unknown): void {
			services.set(name, service);
		},
		async createMemory(memory: Memory, table: string): Promise<UUID> {
			const list = memories.get(table) ?? [];
			const withId: Memory = { ...memory, id: memory.id ?? nextUuid() };
			list.push(withId);
			memories.set(table, list);
			return withId.id as UUID;
		},
		async getMemories(opts: {
			tableName: string;
			entityId?: UUID;
			roomId?: UUID;
			count?: number;
		}): Promise<Memory[]> {
			const list = memories.get(opts.tableName) ?? [];
			return list
				.filter((m) => !opts.entityId || m.entityId === opts.entityId)
				.filter((m) => !opts.roomId || m.roomId === opts.roomId)
				.slice(0, opts.count ?? list.length);
		},
		async deleteMemory(id: UUID): Promise<void> {
			for (const [k, list] of memories.entries()) {
				memories.set(
					k,
					list.filter((m) => m.id !== id),
				);
			}
		},
		async getRoom(): Promise<null> {
			return null;
		},
		async getParticipantUserState(): Promise<null> {
			return null;
		},
		// hasRoleAccess uses these
		getSetting: () => undefined,
		_test_owner: owner,
		_test_admins: admins,
	} as unknown as IAgentRuntime;

	// Make hasRoleAccess succeed by registering the entity as owner/admin via
	// world state — but for unit tests we'd rather bypass entirely. The real
	// hasRoleAccess returns true when there's no world context. Our stub has
	// no world context so it returns true (lenient default) — which is what we
	// want for happy-path tests. For admin-deny tests we'll override.

	const store = new PersonalityStore(runtime);
	// initialize() loads profiles; do it synchronously-ish via a hack
	(runtime as unknown as { registerService: (n: string, s: unknown) => void })
		.registerService;
	services.set("PERSONALITY_STORE", store);
	return { runtime, store, memories };
}

export async function initStore(fake: FakeRuntime): Promise<void> {
	// Bypass private init; we call loadProfilesFromDisk explicitly to seed
	// default profiles (without static start which would re-construct).
	// We treat the in-memory list as the source of truth.
	const profiles = await import("../profiles/index.ts");
	for (const profile of profiles.defaultProfiles) {
		fake.store.saveProfile(profile);
	}
}

export function makeMessage(args: {
	entityId: UUID;
	agentId: UUID;
	text?: string;
	mention?: boolean;
}): Memory {
	const content: Content = {
		text: args.text ?? "",
		...(args.mention ? { mentionContext: { isMention: true } } : {}),
	};
	return {
		id: nextUuid(),
		entityId: args.entityId,
		roomId: nextUuid(),
		agentId: args.agentId,
		content,
		createdAt: Date.now(),
	};
}

export function captureCallback(): {
	cb: HandlerCallback;
	calls: Content[];
} {
	const calls: Content[] = [];
	const cb: HandlerCallback = async (response) => {
		calls.push(response);
		return [];
	};
	return { cb, calls };
}
