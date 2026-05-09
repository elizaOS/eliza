import { DatabaseAdapter } from "../database";
import type {
	Agent,
	AppendConnectorAccountAuditEventParams,
	Component,
	ConnectorAccountAuditEventRecord,
	ConnectorAccountAuditOutcome,
	ConnectorAccountCredentialRefRecord,
	ConnectorAccountJsonObject,
	ConnectorAccountRecord,
	ConsumeOAuthFlowStateParams,
	CreateOAuthFlowStateParams,
	DeleteConnectorAccountParams,
	DeleteOAuthFlowStateParams,
	EntitiesForRoomsResult,
	Entity,
	GetConnectorAccountCredentialRefParams,
	GetConnectorAccountParams,
	GetOAuthFlowStateParams,
	IDatabaseAdapter,
	JsonValue,
	ListConnectorAccountCredentialRefsParams,
	ListConnectorAccountsParams,
	Log,
	LogBody,
	Memory,
	MemoryMetadata,
	Metadata,
	OAuthFlowRecord,
	PairingAllowlistEntry,
	PairingAllowlistsResult,
	PairingChannel,
	PairingRequest,
	PairingRequestsResult,
	Participant,
	ParticipantsForRoomsResult,
	ParticipantUpdateFields,
	ParticipantUserState,
	PatchOp,
	Relationship,
	Room,
	SetConnectorAccountCredentialRefParams,
	Task,
	UpdateOAuthFlowStateParams,
	UpsertConnectorAccountParams,
	UUID,
	World,
} from "../types";
import { DEFAULT_UUID } from "../types/primitives";
import { isPlainObject } from "../utils/type-guards";

function asUuid(id: string): UUID {
	return id as UUID;
}

function randomUuid(): UUID {
	const gen =
		typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	return asUuid(gen);
}

function roomTableKey(tableName: string, roomId: UUID): string {
	return `${tableName}:${String(roomId)}`;
}

function connectorAccountKey(params: {
	agentId: UUID;
	provider: string;
	accountKey: string;
}): string {
	return `${String(params.agentId)}::${params.provider}::${params.accountKey}`;
}

function connectorCredentialKey(params: {
	accountId: UUID;
	credentialType: string;
}): string {
	return `${String(params.accountId)}::${params.credentialType}`;
}

function oauthFlowKey(params: {
	agentId: UUID;
	provider: string;
	stateHash: string;
}): string {
	return `${String(params.agentId)}::${params.provider}::${params.stateHash}`;
}

function connectorDateToMillis(
	value: number | Date | null | undefined,
): number | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	return value instanceof Date ? value.getTime() : value;
}

function cloneConnectorJsonObject(
	value: ConnectorAccountJsonObject | undefined,
): ConnectorAccountJsonObject {
	return value
		? (JSON.parse(JSON.stringify(value)) as ConnectorAccountJsonObject)
		: {};
}

const CONNECTOR_AUDIT_REDACTED = "[REDACTED]";
const CONNECTOR_AUDIT_SECRET_KEY_PATTERN =
	/(access|refresh|id)?_?token|secret|password|credential|authorization|cookie|code[_-]?verifier|codeVerifier|client[_-]?secret|api_?key|private_?key|oauth_?code|state/i;

function redactConnectorAuditValue(value: unknown): JsonValue {
	if (value === null || value === undefined) return null;
	if (Array.isArray(value)) return value.map(redactConnectorAuditValue);
	if (typeof value === "object") {
		const redacted: ConnectorAccountJsonObject = {};
		for (const [key, item] of Object.entries(
			value as Record<string, unknown>,
		)) {
			redacted[key] = CONNECTOR_AUDIT_SECRET_KEY_PATTERN.test(key)
				? CONNECTOR_AUDIT_REDACTED
				: redactConnectorAuditValue(item);
		}
		return redacted;
	}
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	return String(value);
}

function redactConnectorAuditMetadata(
	metadata: Record<string, unknown> | undefined,
): ConnectorAccountJsonObject {
	return redactConnectorAuditValue(
		metadata ?? {},
	) as ConnectorAccountJsonObject;
}

async function sha256Hex(value: string): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) {
		return Array.from(new TextEncoder().encode(value))
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("")
			.padEnd(64, "0")
			.slice(0, 64);
	}
	const digest = await subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function componentNaturalKey(params: {
	entityId: UUID;
	type: string;
	worldId?: UUID;
	sourceEntityId?: UUID;
}): string {
	return [
		String(params.entityId),
		params.type,
		String(params.worldId ?? ""),
		String(params.sourceEntityId ?? ""),
	].join("::");
}

function dataContainsFilter(
	value: unknown,
	filter: Record<string, unknown> | undefined,
): boolean {
	if (!filter) return true;
	if (!isPlainObject(value)) return false;

	for (const [key, expected] of Object.entries(filter)) {
		const actual = value[key];
		if (isPlainObject(expected)) {
			if (!dataContainsFilter(actual, expected)) {
				return false;
			}
			continue;
		}

		if (Array.isArray(expected)) {
			if (!Array.isArray(actual)) return false;
			for (const expectedItem of expected) {
				const found = actual.some((actualItem) => {
					if (isPlainObject(expectedItem)) {
						return dataContainsFilter(actualItem, expectedItem);
					}
					return actualItem === expectedItem;
				});
				if (!found) return false;
			}
			continue;
		}

		if (actual !== expected) {
			return false;
		}
	}

	return true;
}

/**
 * In-memory database adapter.
 *
 * Intended for:
 * - Unit / integration tests (fast, no external dependencies)
 * - Benchmarks (measure agent logic without DB latency)
 * - Serverless / ephemeral runs (no persistence needed)
 *
 * Implements the full batch-first `IDatabaseAdapter` surface using plain
 * Maps and arrays. No single-item CRUD methods exist here -- those are
 * convenience wrappers on AgentRuntime that delegate to these batch methods.
 *
 * WHY Maps and not a single big array:
 * - `memoriesById` gives O(1) ID lookups (batch getMemoriesByIds)
 * - `memoriesByRoom` gives O(1) room-scoped queries (getMemories, countMemories)
 * - This mirrors how SQL adapters use indexed columns, keeping the
 *   in-memory adapter's performance characteristics honest.
 *
 * Persistence is process-local. Data is lost on restart.
 */
export class InMemoryDatabaseAdapter extends DatabaseAdapter<
	Record<string, never>
> {
	db: Record<string, never> = {};

	private ready = false;

	private agents = new Map<string, Partial<Agent>>();
	private entities = new Map<string, Entity>();
	private components = new Map<string, Component>();
	private componentIdsByEntity = new Map<string, Set<string>>();
	private componentIdsByNaturalKey = new Map<string, string>();
	private rooms = new Map<string, Room>();
	private worlds = new Map<string, World>();
	private tasks = new Map<string, Task>();
	private logs: Log[] = [];

	private memoriesById = new Map<string, Memory>();
	private memoriesByRoom = new Map<string, Memory[]>();
	private cache = new Map<string, string>();

	private participantsByRoom = new Map<string, Set<string>>();
	private roomsByParticipant = new Map<string, Set<string>>();
	private participantUserState = new Map<string, "FOLLOWED" | "MUTED" | null>();

	// Pairing storage
	private pairingRequests = new Map<string, PairingRequest>();
	private pairingAllowlist = new Map<string, PairingAllowlistEntry>();

	private connectorAccountsById = new Map<string, ConnectorAccountRecord>();
	private connectorAccountIdsByKey = new Map<string, string>();
	private connectorCredentialRefs = new Map<
		string,
		ConnectorAccountCredentialRefRecord
	>();
	private connectorAuditEvents: ConnectorAccountAuditEventRecord[] = [];
	private oauthFlowsByStateHash = new Map<string, OAuthFlowRecord>();

	private cloneComponent(component: Component): Component {
		return {
			...component,
			data: component.data
				? ({ ...component.data } as Metadata)
				: component.data,
		};
	}

	private attachComponents(entity: Entity, components?: Component[]): Entity {
		const attachedComponents =
			components ?? this.getStoredComponentsForEntity(entity.id);
		if (!attachedComponents.length) {
			return { ...entity };
		}
		return {
			...entity,
			components: attachedComponents.map((component) =>
				this.cloneComponent(component),
			),
		};
	}

	private getStoredComponentsForEntity(
		entityId: UUID | undefined,
		options?: { worldId?: UUID; sourceEntityId?: UUID },
	): Component[] {
		if (!entityId) return [];
		const componentIds = this.componentIdsByEntity.get(String(entityId));
		if (!componentIds) return [];

		const components: Component[] = [];
		for (const componentId of componentIds) {
			const component = this.components.get(componentId);
			if (!component) continue;
			if (
				options?.worldId !== undefined &&
				component.worldId !== options.worldId
			) {
				continue;
			}
			if (
				options?.sourceEntityId !== undefined &&
				component.sourceEntityId !== options.sourceEntityId
			) {
				continue;
			}
			components.push(component);
		}
		return components;
	}

	private indexComponent(component: Component): void {
		const componentId = String(component.id);
		this.components.set(componentId, this.cloneComponent(component));

		const entityKey = String(component.entityId);
		const entityComponents =
			this.componentIdsByEntity.get(entityKey) ?? new Set<string>();
		entityComponents.add(componentId);
		this.componentIdsByEntity.set(entityKey, entityComponents);

		this.componentIdsByNaturalKey.set(
			componentNaturalKey(component),
			componentId,
		);
	}

	private removeComponentIndexes(component: Component | undefined): void {
		if (!component) return;

		const componentId = String(component.id);
		const entityKey = String(component.entityId);
		const entityComponents = this.componentIdsByEntity.get(entityKey);
		if (entityComponents) {
			entityComponents.delete(componentId);
			if (entityComponents.size === 0) {
				this.componentIdsByEntity.delete(entityKey);
			}
		}

		this.componentIdsByNaturalKey.delete(componentNaturalKey(component));
	}

	async initialize(_config?: Record<string, string | number | boolean | null>) {
		this.ready = true;
	}

	async init() {
		this.ready = true;
	}

	async runPluginMigrations() {
		// no-op
	}

	async runMigrations() {
		// no-op
	}

	async isReady(): Promise<boolean> {
		return this.ready;
	}

	async close(): Promise<void> {
		this.ready = false;
	}

	async getConnection(): Promise<Record<string, never>> {
		return this.db;
	}

	// Batch agent methods
	async getAgentsByIds(agentIds: UUID[]): Promise<Agent[]> {
		const agents: Agent[] = [];
		for (const id of agentIds) {
			const agent = this.agents.get(String(id));
			if (agent?.id) {
				agents.push(agent as Agent);
			}
		}
		return agents;
	}

	async createAgents(agents: Partial<Agent>[]): Promise<UUID[]> {
		const ids: UUID[] = [];
		for (const agent of agents) {
			if (agent.id) {
				this.agents.set(String(agent.id), agent);
				ids.push(agent.id);
			}
		}
		return ids;
	}

	async upsertAgents(agents: Partial<Agent>[]): Promise<void> {
		// WHY simple set: Map.set() overwrites if key exists, inserts if not.
		// This is the InMemory equivalent of ON CONFLICT DO UPDATE.
		for (const agent of agents) {
			if (agent.id) {
				this.agents.set(String(agent.id), agent);
			}
		}
	}

	async updateAgents(
		updates: Array<{ agentId: UUID; agent: Partial<Agent> }>,
	): Promise<boolean> {
		for (const { agentId, agent } of updates) {
			const existing = this.agents.get(String(agentId)) ?? {};
			this.agents.set(String(agentId), { ...existing, ...agent, id: agentId });
		}
		return true;
	}

	async deleteAgents(agentIds: UUID[]): Promise<boolean> {
		for (const id of agentIds) {
			this.agents.delete(String(id));
		}
		return true;
	}

	async countAgents(): Promise<number> {
		return this.agents.size;
	}

	async cleanupAgents(): Promise<void> {
		// WHY no-op: InMemory adapter has no persistent storage, so no cleanup needed.
		// Agents are automatically cleared when process restarts.
	}

	async getAgents(): Promise<Partial<Agent>[]> {
		return Array.from(this.agents.values());
	}

	async ensureEmbeddingDimension(_dimension: number): Promise<void> {
		// no-op
	}

	async transaction<T>(
		callback: (tx: IDatabaseAdapter<Record<string, never>>) => Promise<T>,
		_options?: { entityContext?: UUID },
	): Promise<T> {
		return callback(this);
	}

	async queryEntities(_params: {
		componentType?: string;
		componentDataFilter?: Record<string, unknown>;
		agentId?: UUID;
		entityIds?: UUID[];
		worldId?: UUID;
		limit?: number;
		offset?: number;
		includeAllComponents?: boolean;
		entityContext?: UUID;
	}): Promise<Entity[]> {
		const matchedComponentsByEntity = new Map<string, Component[]>();
		const hasComponentQuery =
			_params.componentType !== undefined ||
			_params.componentDataFilter !== undefined ||
			_params.worldId !== undefined;

		if (hasComponentQuery) {
			for (const component of this.components.values()) {
				if (_params.agentId && component.agentId !== _params.agentId) continue;
				if (
					_params.entityIds?.length &&
					!_params.entityIds.includes(component.entityId)
				) {
					continue;
				}
				if (
					_params.worldId !== undefined &&
					component.worldId !== _params.worldId
				) {
					continue;
				}
				if (
					_params.componentType !== undefined &&
					component.type !== _params.componentType
				) {
					continue;
				}
				if (
					_params.componentDataFilter !== undefined &&
					!dataContainsFilter(component.data, _params.componentDataFilter)
				) {
					continue;
				}

				const entityKey = String(component.entityId);
				const bucket = matchedComponentsByEntity.get(entityKey) ?? [];
				bucket.push(this.cloneComponent(component));
				matchedComponentsByEntity.set(entityKey, bucket);
			}
		}

		let entityIds: UUID[] = [];
		if (matchedComponentsByEntity.size > 0) {
			entityIds = Array.from(matchedComponentsByEntity.keys()).map(asUuid);
		} else if (_params.entityIds?.length) {
			entityIds = [..._params.entityIds];
		} else {
			return [];
		}

		const offset = _params.offset ?? 0;
		const limit = _params.limit ?? entityIds.length;
		entityIds = entityIds.slice(offset, offset + limit);

		const entities: Entity[] = [];
		for (const entityId of entityIds) {
			const entity = this.entities.get(String(entityId));
			if (!entity) continue;
			if (
				_params.agentId &&
				entity.agentId &&
				entity.agentId !== _params.agentId
			) {
				continue;
			}

			const matchedComponents =
				matchedComponentsByEntity.get(String(entityId)) ?? [];
			const components = _params.includeAllComponents
				? this.getStoredComponentsForEntity(entity.id)
				: matchedComponents;
			entities.push(this.attachComponents(entity, components));
		}

		return entities;
	}

	async getEntitiesForRooms(
		roomIds: UUID[],
		_includeComponents?: boolean,
	): Promise<EntitiesForRoomsResult> {
		const result: EntitiesForRoomsResult = [];
		for (const roomId of roomIds) {
			const participantSet = this.participantsByRoom.get(String(roomId));
			const entities: Entity[] = [];
			if (participantSet) {
				for (const entityIdStr of participantSet) {
					const entity = this.entities.get(entityIdStr);
					if (entity) {
						entities.push(
							_includeComponents
								? this.attachComponents(entity)
								: { ...entity },
						);
					}
				}
			}
			result.push({ roomId, entities });
		}
		return result;
	}

	async createEntities(entities: Entity[]): Promise<UUID[]> {
		const ids: UUID[] = [];
		for (const e of entities) {
			if (!e.id) throw new Error("Entity id is required");
			this.entities.set(String(e.id), e);
			ids.push(e.id);
		}
		return ids;
	}

	async upsertEntities(entities: Entity[]): Promise<void> {
		// WHY simple set: For InMemory, upsert is just Map.set() which naturally
		// handles both insert (new key) and update (existing key) cases.
		for (const entity of entities) {
			this.entities.set(String(entity.id), entity);
		}
	}

	async searchEntitiesByName(params: {
		query: string;
		agentId: UUID;
		limit?: number;
	}): Promise<Entity[]> {
		// WHY O(N) scan: InMemory has no indexing, so we iterate all entities.
		// Case-insensitive substring match on any name in the names array.
		const lowerQuery = params.query.toLowerCase();
		const limit = params.limit ?? 10;
		const matches: Entity[] = [];

		for (const entity of this.entities.values()) {
			if (entity.agentId !== params.agentId) continue;

			const hasMatch = entity.names?.some((name) =>
				name.toLowerCase().includes(lowerQuery),
			);

			if (hasMatch) {
				matches.push(entity);
				if (matches.length >= limit) break;
			}
		}

		return matches;
	}

	async getEntitiesByNames(params: {
		names: string[];
		agentId: UUID;
	}): Promise<Entity[]> {
		// WHY O(N) scan: InMemory has no indexing. Match ANY name in entity.names.
		// Case-sensitive exact match (consistent with SQL implementations).
		const nameSet = new Set(params.names);
		const matches: Entity[] = [];

		for (const entity of this.entities.values()) {
			if (entity.agentId !== params.agentId) continue;

			const hasMatch = entity.names?.some((name) => nameSet.has(name));
			if (hasMatch) {
				matches.push(entity);
			}
		}

		return matches;
	}

	async getComponentsByNaturalKeys(
		keys: Array<{
			entityId: UUID;
			type: string;
			worldId?: UUID;
			sourceEntityId?: UUID;
		}>,
	): Promise<(Component | null)[]> {
		return keys.map((key) => {
			const componentId = this.componentIdsByNaturalKey.get(
				componentNaturalKey(key),
			);
			const component = componentId
				? this.components.get(componentId)
				: undefined;
			return component ? this.cloneComponent(component) : null;
		});
	}

	async getComponentsForEntities(
		_entityIds: UUID[],
		_worldId?: UUID,
		_sourceEntityId?: UUID,
	): Promise<Component[]> {
		const components: Component[] = [];
		for (const entityId of _entityIds) {
			components.push(
				...this.getStoredComponentsForEntity(entityId, {
					worldId: _worldId,
					sourceEntityId: _sourceEntityId,
				}).map((component) => this.cloneComponent(component)),
			);
		}
		return components;
	}

	// Batch entity methods
	async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
		const entities: Entity[] = [];
		for (const entityId of entityIds) {
			const entity = this.entities.get(String(entityId));
			if (entity) entities.push({ ...entity });
		}
		return entities;
	}

	async updateEntities(entities: Entity[]): Promise<void> {
		for (const entity of entities) {
			this.entities.set(String(entity.id), entity);
		}
	}

	async deleteEntities(entityIds: UUID[]): Promise<void> {
		for (const entityId of entityIds) {
			this.entities.delete(String(entityId));
		}
	}

	// Batch component methods
	async createComponents(components: Component[]): Promise<UUID[]> {
		for (const component of components) {
			this.indexComponent(component);
		}
		return components.map((c) => c.id);
	}

	async getComponentsByIds(_componentIds: UUID[]): Promise<Component[]> {
		return _componentIds
			.map((componentId) => this.components.get(String(componentId)))
			.filter((component): component is Component => component !== undefined)
			.map((component) => this.cloneComponent(component));
	}

	async updateComponents(_components: Component[]): Promise<void> {
		for (const component of _components) {
			const existing = this.components.get(String(component.id));
			if (existing) {
				this.removeComponentIndexes(existing);
			}
			this.indexComponent(component);
		}
	}

	async deleteComponents(_componentIds: UUID[]): Promise<void> {
		for (const componentId of _componentIds) {
			const existing = this.components.get(String(componentId));
			this.removeComponentIndexes(existing);
			this.components.delete(String(componentId));
		}
	}

	async upsertComponents(
		_components: Component[],
		_options?: { entityContext?: UUID },
	): Promise<void> {
		for (const component of _components) {
			const existingId = this.componentIdsByNaturalKey.get(
				componentNaturalKey(component),
			);
			if (!existingId) {
				this.indexComponent(component);
				continue;
			}

			const existing = this.components.get(existingId);
			if (!existing) {
				this.indexComponent(component);
				continue;
			}

			this.removeComponentIndexes(existing);
			this.indexComponent({
				...existing,
				agentId: component.agentId,
				roomId: component.roomId,
				data: component.data,
			});
		}
	}

	async patchComponents(
		_updates: Array<{ componentId: UUID; ops: PatchOp[] }>,
		_options?: { entityContext?: UUID },
	): Promise<void> {
		// InMemory does not persist components; no-op for compatibility.
	}

	async getMemories(params: {
		entityId?: UUID;
		agentId?: UUID;
		limit?: number;
		count?: number;
		offset?: number;
		unique?: boolean;
		tableName: string;
		start?: number;
		end?: number;
		roomId?: UUID;
		worldId?: UUID;
		metadata?: Record<string, unknown>;
	}): Promise<Memory[]> {
		const effectiveLimit = params.limit ?? params.count ?? Infinity;
		const roomId = params.roomId ?? DEFAULT_UUID;
		const tableName = params.tableName ?? "messages";
		let all = this.memoriesByRoom.get(roomTableKey(tableName, roomId)) ?? [];

		// Filter by timestamp range (start/end are timestamps in milliseconds)
		// This supports history compaction - only return messages after the compaction point
		if (params.start !== undefined || params.end !== undefined) {
			all = all.filter((memory) => {
				const createdAt = memory.createdAt ?? 0;
				if (params.start !== undefined && createdAt < params.start) {
					return false;
				}
				if (params.end !== undefined && createdAt > params.end) {
					return false;
				}
				return true;
			});
		}

		// WHY: In-memory metadata filtering uses deep equality check for each
		// filter key. This is less efficient than SQL containment operators but
		// correct for nested objects/arrays. Matches PG @> and MySQL JSON_CONTAINS semantics.
		if (params.metadata) {
			const filterMeta = params.metadata as Record<string, unknown>;
			all = all.filter((memory) => {
				if (!memory.metadata) return false;
				const memMeta = memory.metadata as Record<string, unknown>;
				// Check if memory.metadata contains all key-value pairs from params.metadata
				for (const [key, value] of Object.entries(filterMeta)) {
					if (!(key in memMeta)) return false;
					// Deep equality check for nested objects/arrays
					if (JSON.stringify(memMeta[key]) !== JSON.stringify(value)) {
						return false;
					}
				}
				return true;
			});
		}

		// Match plugin-sql ordering: newest first, then id desc as tiebreaker.
		// Without this, `count: N` returns the N oldest instead of the N newest,
		// which silently diverges from plugin-sql once a room exceeds N memories.
		all = all.slice().sort((a, b) => {
			const ta = a.createdAt ?? 0;
			const tb = b.createdAt ?? 0;
			if (ta !== tb) return tb - ta;
			return String(b.id ?? "").localeCompare(String(a.id ?? ""));
		});

		const offset = params.offset ?? 0;
		return all.slice(
			offset,
			offset + (effectiveLimit === Infinity ? all.length : effectiveLimit),
		);
	}

	async getMemoriesByIds(ids: UUID[]): Promise<Memory[]> {
		const out: Memory[] = [];
		for (const id of ids) {
			const m = this.memoriesById.get(String(id));
			if (m) out.push(m);
		}
		return out;
	}

	async getMemoriesByRoomIds(params: {
		tableName: string;
		roomIds: UUID[];
		limit?: number;
	}): Promise<Memory[]> {
		const limit = params.limit ?? 20;
		const out: Memory[] = [];
		for (const rid of params.roomIds) {
			const list =
				this.memoriesByRoom.get(roomTableKey(params.tableName, rid)) ?? [];
			for (const m of list) {
				out.push(m);
				if (out.length >= limit) return out;
			}
		}
		return out;
	}

	async getCachedEmbeddings(): Promise<
		{ embedding: number[]; levenshtein_score: number }[]
	> {
		return [];
	}

	async getLogs(params: {
		entityId?: UUID;
		roomId?: UUID;
		type?: string;
		limit?: number;
		offset?: number;
	}): Promise<Log[]> {
		const effectiveLimit = params.limit ?? 10;
		let filtered = this.logs;

		// Filter by entityId if provided
		if (params.entityId !== undefined) {
			filtered = filtered.filter((log) => log.entityId === params.entityId);
		}

		// Filter by roomId if provided
		if (params.roomId !== undefined) {
			filtered = filtered.filter((log) => log.roomId === params.roomId);
		}

		// Filter by type if provided
		if (params.type !== undefined) {
			filtered = filtered.filter((log) => log.type === params.type);
		}

		// Apply offset (skip first N results)
		const offset = params.offset ?? 0;
		filtered = filtered.slice(offset);

		// Apply limit (limit results)
		filtered = filtered.slice(0, effectiveLimit);

		return filtered;
	}

	// Batch log methods
	async getLogsByIds(logIds: UUID[]): Promise<Log[]> {
		const idSet = new Set(logIds.map(String));
		return this.logs.filter((l) => idSet.has(String(l.id)));
	}

	async createLogs(
		params: Array<{
			body: LogBody;
			entityId: UUID;
			roomId: UUID;
			type: string;
		}>,
	): Promise<void> {
		for (const param of params) {
			const id =
				typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
					? crypto.randomUUID()
					: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
			this.logs.push({
				id: asUuid(id),
				createdAt: new Date(),
				entityId: param.entityId,
				roomId: param.roomId,
				type: param.type,
				body: param.body,
			});
		}
	}

	async updateLogs(
		logs: Array<{ id: UUID; updates: Partial<Log> }>,
	): Promise<void> {
		for (const { id, updates } of logs) {
			const log = this.logs.find((l) => String(l.id) === String(id));
			if (log) {
				Object.assign(log, updates);
			}
		}
	}

	async deleteLogs(logIds: UUID[]): Promise<void> {
		const idSet = new Set(logIds.map(String));
		this.logs = this.logs.filter((l) => !idSet.has(String(l.id)));
	}

	async searchMemories(): Promise<Memory[]> {
		return [];
	}

	// Batch memory methods
	async createMemories(
		memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>,
	): Promise<UUID[]> {
		const ids: UUID[] = [];
		for (const { memory, tableName } of memories) {
			const gen =
				typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
					? crypto.randomUUID()
					: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
			const id = memory.id ? String(memory.id) : gen;
			const stored: Memory = {
				...memory,
				id: asUuid(id),
			};
			this.memoriesById.set(id, stored);
			const roomId = memory.roomId ?? DEFAULT_UUID;
			const key = roomTableKey(tableName, roomId);
			const list = this.memoriesByRoom.get(key) ?? [];
			list.push(stored);
			this.memoriesByRoom.set(key, list);
			ids.push(asUuid(id));
		}
		return ids;
	}

	async updateMemories(
		memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>,
	): Promise<void> {
		for (const memory of memories) {
			const existing = this.memoriesById.get(String(memory.id));
			if (!existing) {
				// WHY: Changed from returning false to skipping. Update failures should
				// ideally throw, but silently skipping non-existent memories maintains
				// backward compatibility with callers that may not check return values.
				continue;
			}
			const merged: Memory = { ...existing, ...memory };
			this.memoriesById.set(String(memory.id), merged);
			// Update reference in memoriesByRoom to keep consistency
			const oldRoomId = existing.roomId ?? DEFAULT_UUID;
			const newRoomId = merged.roomId ?? DEFAULT_UUID;
			for (const [key, list] of this.memoriesByRoom) {
				const idx = list.findIndex((m) => String(m.id) === String(memory.id));
				if (idx !== -1) {
					if (String(oldRoomId) !== String(newRoomId)) {
						const tableName = key.split(":")[0];
						list.splice(idx, 1);
						const newKey = roomTableKey(tableName, newRoomId);
						const newList = this.memoriesByRoom.get(newKey) ?? [];
						newList.push(merged);
						this.memoriesByRoom.set(newKey, newList);
					} else {
						list[idx] = merged;
					}
					break;
				}
			}
		}
	}

	async upsertMemories(
		memories: Array<{ memory: Memory; tableName: string }>,
		_options?: { entityContext?: UUID },
	): Promise<void> {
		for (const { memory, tableName } of memories) {
			const id = memory.id;
			if (id == null) {
				await this.createMemories([{ memory, tableName }]);
				continue;
			}
			if (this.memoriesById.has(String(id))) {
				await this.updateMemories([{ ...memory, id }]);
			} else {
				await this.createMemories([{ memory, tableName }]);
			}
		}
	}

	async deleteMemories(memoryIds: UUID[]): Promise<void> {
		const idSet = new Set(memoryIds.map(String));
		for (const id of memoryIds) {
			this.memoriesById.delete(String(id));
		}
		// Clean up memoriesByRoom references
		for (const [key, list] of this.memoriesByRoom) {
			const filtered = list.filter((m) => !idSet.has(String(m.id)));
			if (filtered.length === 0) {
				this.memoriesByRoom.delete(key);
			} else if (filtered.length !== list.length) {
				this.memoriesByRoom.set(key, filtered);
			}
		}
	}

	async deleteAllMemories(roomIds: UUID[], tableName: string): Promise<void> {
		for (const roomId of roomIds) {
			const key = roomTableKey(tableName, roomId);
			const memories = this.memoriesByRoom.get(key) ?? [];
			for (const mem of memories) {
				this.memoriesById.delete(String(mem.id));
			}
			this.memoriesByRoom.delete(key);
		}
	}

	async countMemories(params: {
		roomIds?: UUID[];
		unique?: boolean;
		tableName?: string;
		entityId?: UUID;
		agentId?: UUID;
		metadata?: Record<string, unknown>;
	}): Promise<number> {
		const roomIds = params.roomIds ?? [];
		const tbl = params.tableName ?? "messages";
		const u = params.unique;
		let total = 0;
		if (roomIds.length === 0) {
			// No room filter: count all memories matching tableName and other filters (consistent with SQL/store behavior)
			const prefix = `${tbl}:`;
			for (const [key, memories] of this.memoriesByRoom) {
				if (!key.startsWith(prefix)) continue;
				let list = memories;
				if (params.entityId)
					list = list.filter((m) => m.entityId === params.entityId);
				if (params.agentId)
					list = list.filter((m) => m.agentId === params.agentId);
				total += u ? list.filter((m) => m.unique).length : list.length;
			}
			return total;
		}
		for (const roomId of roomIds) {
			const key = roomTableKey(tbl, roomId);
			const memories = this.memoriesByRoom.get(key) ?? [];
			let list = memories;
			if (params.entityId)
				list = list.filter((m) => m.entityId === params.entityId);
			if (params.agentId)
				list = list.filter((m) => m.agentId === params.agentId);
			total += u ? list.filter((m) => m.unique).length : list.length;
		}
		return total;
	}

	// Batch world methods
	async getWorldsByIds(worldIds: UUID[]): Promise<World[]> {
		const worlds: World[] = [];
		for (const id of worldIds) {
			const world = this.worlds.get(String(id));
			if (world) {
				worlds.push(world);
			}
		}
		return worlds;
	}

	async createWorlds(worlds: World[]): Promise<UUID[]> {
		const ids: UUID[] = [];
		for (const world of worlds) {
			this.worlds.set(String(world.id), world);
			ids.push(world.id);
		}
		return ids;
	}

	async upsertWorlds(worlds: World[]): Promise<void> {
		// WHY simple set: Map.set() handles both insert and update atomically.
		for (const world of worlds) {
			this.worlds.set(String(world.id), world);
		}
	}

	async deleteWorlds(worldIds: UUID[]): Promise<void> {
		for (const id of worldIds) {
			this.worlds.delete(String(id));
		}
	}

	async updateWorlds(worlds: World[]): Promise<void> {
		for (const world of worlds) {
			this.worlds.set(String(world.id), world);
		}
	}

	async getAllWorlds(): Promise<World[]> {
		return Array.from(this.worlds.values());
	}

	// Batch room methods
	async updateRooms(rooms: Room[]): Promise<void> {
		for (const room of rooms) {
			this.rooms.set(String(room.id), room);
		}
	}

	async deleteRooms(roomIds: UUID[]): Promise<void> {
		for (const id of roomIds) {
			this.rooms.delete(String(id));
		}
	}

	async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
		const out: Room[] = [];
		for (const id of roomIds) {
			const r = this.rooms.get(String(id));
			if (r) out.push(r);
		}
		return out;
	}

	async createRooms(rooms: Room[]): Promise<UUID[]> {
		const ids: UUID[] = [];
		for (const r of rooms) {
			this.rooms.set(String(r.id), r);
			ids.push(r.id);
		}
		return ids;
	}

	async upsertRooms(rooms: Room[]): Promise<void> {
		// WHY simple set: InMemory upsert is just Map.set() - idempotent by nature.
		for (const room of rooms) {
			this.rooms.set(String(room.id), room);
		}
	}

	async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
		const out = new Set<string>();
		for (const id of entityIds) {
			const set = this.roomsByParticipant.get(String(id));
			if (!set) continue;
			for (const roomId of set.values()) out.add(roomId);
		}
		return Array.from(out.values()).map(asUuid);
	}

	async getRoomsByWorlds(
		worldIds: UUID[],
		limit?: number,
		offset?: number,
	): Promise<Room[]> {
		let out: Room[] = [];
		for (const room of this.rooms.values()) {
			if (room.worldId && worldIds.includes(room.worldId)) {
				out.push(room);
			}
		}
		const off = offset ?? 0;
		out = out.slice(off);
		if (limit != null) out = out.slice(0, limit);
		return out;
	}

	async getParticipantsForEntities(entityIds: UUID[]): Promise<Participant[]> {
		const out: Participant[] = [];
		for (const entityId of entityIds) {
			const entity = this.entities.get(String(entityId));
			if (entity) out.push({ id: entityId, entity });
		}
		return out;
	}

	async getParticipantsForRooms(
		roomIds: UUID[],
	): Promise<ParticipantsForRoomsResult> {
		const result: ParticipantsForRoomsResult = [];
		for (const roomId of roomIds) {
			const set = this.participantsByRoom.get(String(roomId));
			const entityIds = set ? Array.from(set.values()).map(asUuid) : [];
			result.push({ roomId, entityIds });
		}
		return result;
	}

	async createRoomParticipants(
		entityIds: UUID[],
		roomId: UUID,
	): Promise<UUID[]> {
		// WHY: InMemory doesn't have real participant record IDs (it's just a set).
		// We generate UUIDs to match the interface contract, even though they're not stored.
		const roomKey = String(roomId);
		const participants =
			this.participantsByRoom.get(roomKey) ?? new Set<string>();
		const ids: UUID[] = [];

		for (const eid of entityIds) {
			const entityKey = String(eid);
			participants.add(entityKey);
			const rooms = this.roomsByParticipant.get(entityKey) ?? new Set<string>();
			rooms.add(roomKey);
			this.roomsByParticipant.set(entityKey, rooms);
			// Generate a synthetic ID for this participant record
			ids.push(`${roomId}:${eid}` as UUID);
		}
		this.participantsByRoom.set(roomKey, participants);
		return ids;
	}

	// Batch participant methods
	async deleteParticipants(
		participants: Array<{ entityId: UUID; roomId: UUID }>,
	): Promise<boolean> {
		for (const { entityId, roomId } of participants) {
			const roomKey = String(roomId);
			const entityKey = String(entityId);
			const roomParticipants = this.participantsByRoom.get(roomKey);
			if (roomParticipants) {
				roomParticipants.delete(entityKey);
				if (roomParticipants.size === 0)
					this.participantsByRoom.delete(roomKey);
			}
			const rooms = this.roomsByParticipant.get(entityKey);
			if (rooms) {
				rooms.delete(roomKey);
				if (rooms.size === 0) this.roomsByParticipant.delete(entityKey);
			}
			this.participantUserState.delete(`${roomKey}:${entityKey}`);
		}
		return true;
	}

	async updateParticipants(
		participants: Array<{
			entityId: UUID;
			roomId: UUID;
			updates: ParticipantUpdateFields;
		}>,
	): Promise<void> {
		// InMemory adapter stores participants as just sets of IDs, so we can only
		// update roomState (which is stored separately in participantUserState).
		// Metadata updates are not supported in this simple adapter.
		for (const { entityId, roomId, updates } of participants) {
			const roomState = updates.roomState;
			if (roomState !== undefined) {
				const key = `${String(roomId)}:${String(entityId)}`;
				this.participantUserState.set(key, roomState);
			}
		}
	}

	async areRoomParticipants(
		pairs: Array<{ roomId: UUID; entityId: UUID }>,
	): Promise<boolean[]> {
		return pairs.map(({ roomId, entityId }) => {
			const set = this.participantsByRoom.get(String(roomId));
			return set ? set.has(String(entityId)) : false;
		});
	}

	async getParticipantUserStates(
		pairs: Array<{ roomId: UUID; entityId: UUID }>,
	): Promise<ParticipantUserState[]> {
		return pairs.map(({ roomId, entityId }) => {
			const key = `${String(roomId)}:${String(entityId)}`;
			return this.participantUserState.get(key) ?? null;
		});
	}

	async updateParticipantUserStates(
		updates: Array<{
			roomId: UUID;
			entityId: UUID;
			state: ParticipantUserState;
		}>,
	): Promise<void> {
		for (const { roomId, entityId, state } of updates) {
			const key = `${String(roomId)}:${String(entityId)}`;
			this.participantUserState.set(key, state);
		}
	}

	async getRelationshipsByPairs(
		_pairs: Array<{ sourceEntityId: UUID; targetEntityId: UUID }>,
	): Promise<(Relationship | null)[]> {
		return _pairs.map(() => null);
	}

	async getRelationships(_params: {
		entityIds?: UUID[];
		tags?: string[];
		limit?: number;
		offset?: number;
	}): Promise<Relationship[]> {
		return [];
	}

	// Batch relationship methods
	async createRelationships(
		relationships: Array<{
			sourceEntityId: UUID;
			targetEntityId: UUID;
			tags?: string[];
			metadata?: Metadata;
		}>,
	): Promise<UUID[]> {
		// WHY: InMemory adapter doesn't actually store relationships, but we return
		// placeholder IDs to match the interface contract.
		return relationships.map(() => {
			const gen =
				typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
					? crypto.randomUUID()
					: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
			return gen as UUID;
		});
	}

	async getRelationshipsByIds(
		_relationshipIds: UUID[],
	): Promise<Relationship[]> {
		return [];
	}

	async updateRelationships(_relationships: Relationship[]): Promise<void> {
		// no-op
	}

	async deleteRelationships(_relationshipIds: UUID[]): Promise<void> {
		// no-op
	}

	// Batch cache methods
	async getCaches<T>(keys: string[]): Promise<Map<string, T>> {
		const result = new Map<string, T>();
		for (const key of keys) {
			const raw = this.cache.get(key);
			if (raw === undefined) continue;
			result.set(key, JSON.parse(raw) as T);
		}
		return result;
	}

	async setCaches<T>(
		entries: Array<{ key: string; value: T }>,
	): Promise<boolean> {
		for (const entry of entries) {
			this.cache.set(entry.key, JSON.stringify(entry.value));
		}
		return true;
	}

	async deleteCaches(keys: string[]): Promise<boolean> {
		for (const key of keys) {
			this.cache.delete(key);
		}
		return true;
	}

	async getTasks(params: {
		roomId?: UUID;
		tags?: string[];
		entityId?: UUID;
		agentIds: UUID[];
		limit?: number;
		offset?: number;
	}): Promise<Task[]> {
		if (params.agentIds.length === 0) return [];
		const all = Array.from(this.tasks.values());
		let filtered = all.filter((t) => {
			if (params.roomId && t.roomId !== params.roomId) return false;
			if (params.entityId && t.entityId !== params.entityId) return false;
			if (t.agentId == null || !params.agentIds.includes(t.agentId))
				return false;
			if (params.tags && params.tags.length > 0) {
				for (const tag of params.tags) {
					if (!t.tags?.includes(tag)) return false;
				}
			}
			return true;
		});

		// WHY: Apply pagination to limit result size. Previously returned ALL matching tasks.
		const offset = params.offset ?? 0;
		filtered = filtered.slice(offset);
		if (params.limit) {
			filtered = filtered.slice(0, params.limit);
		}

		return filtered;
	}

	async getTasksByName(name: string): Promise<Task[]> {
		return Array.from(this.tasks.values()).filter((t) => t.name === name);
	}

	// Batch task methods
	async createTasks(tasks: Task[]): Promise<UUID[]> {
		const ids: UUID[] = [];
		for (const task of tasks) {
			const gen =
				typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
					? crypto.randomUUID()
					: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
			const id = task.id ? String(task.id) : gen;
			const taskId = asUuid(id);
			const stored: Task = { ...task, id: taskId };
			this.tasks.set(id, stored);
			ids.push(taskId);
		}
		return ids;
	}

	async getTasksByIds(taskIds: UUID[]): Promise<Task[]> {
		const tasks: Task[] = [];
		for (const taskId of taskIds) {
			const task = this.tasks.get(String(taskId));
			if (task) tasks.push(task);
		}
		return tasks;
	}

	async updateTasks(
		updates: Array<{ id: UUID; task: Partial<Task> }>,
	): Promise<void> {
		for (const update of updates) {
			const existing = this.tasks.get(String(update.id));
			if (!existing) continue;
			this.tasks.set(String(update.id), {
				...existing,
				...update.task,
				id: update.id,
			} as Task);
		}
	}

	async deleteTasks(taskIds: UUID[]): Promise<void> {
		for (const taskId of taskIds) {
			this.tasks.delete(String(taskId));
		}
	}

	async getMemoriesByWorldId(params: {
		worldIds?: UUID[];
		limit?: number;
		tableName?: string;
	}): Promise<Memory[]> {
		const worldIds = params.worldIds ?? [];
		if (worldIds.length === 0) return [];
		const rooms = await this.getRoomsByWorlds(worldIds);
		const roomIds = rooms.map((r) => r.id);
		const effectiveLimit = params.limit ?? 50;
		const out: Memory[] = [];
		for (const rid of roomIds) {
			if (params.tableName) {
				const list =
					this.memoriesByRoom.get(roomTableKey(params.tableName, rid)) ?? [];
				for (const m of list) {
					out.push(m);
					if (out.length >= effectiveLimit) return out;
				}
				continue;
			}
			for (const [key, list] of this.memoriesByRoom.entries()) {
				if (!key.endsWith(`:${String(rid)}`)) continue;
				for (const m of list) {
					out.push(m);
					if (out.length >= effectiveLimit) return out;
				}
			}
		}
		return out;
	}

	async deleteRoomsByWorldIds(worldIds: UUID[]): Promise<void> {
		for (const worldId of worldIds) {
			const rooms = await this.getRoomsByWorlds([worldId]);
			for (const room of rooms) {
				const roomKey = String(room.id);
				this.rooms.delete(roomKey);
				for (const key of this.memoriesByRoom.keys()) {
					if (key.endsWith(`:${roomKey}`)) this.memoriesByRoom.delete(key);
				}
				this.participantsByRoom.delete(roomKey);
				for (const [entityKey, roomSet] of this.roomsByParticipant.entries()) {
					if (roomSet.delete(roomKey) && roomSet.size === 0)
						this.roomsByParticipant.delete(entityKey);
				}
				for (const key of this.participantUserState.keys()) {
					if (key.startsWith(`${roomKey}:`))
						this.participantUserState.delete(key);
				}
			}
		}
	}

	// ===============================
	// Pairing Methods
	// ===============================

	async getPairingRequests(
		queries: Array<{ channel: PairingChannel; agentId: UUID }>,
	): Promise<PairingRequestsResult> {
		const result: PairingRequestsResult = [];
		for (const { channel, agentId } of queries) {
			const requests: PairingRequest[] = [];
			for (const request of this.pairingRequests.values()) {
				if (request.channel === channel && request.agentId === agentId) {
					requests.push(request);
				}
			}
			requests.sort(
				(a, b) =>
					new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
			);
			result.push({ channel, agentId, requests });
		}
		return result;
	}

	// Batch pairing request methods
	async createPairingRequests(requests: PairingRequest[]): Promise<UUID[]> {
		const ids: UUID[] = [];
		for (const request of requests) {
			const gen =
				typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
					? crypto.randomUUID()
					: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
			const id = request.id ? String(request.id) : gen;
			const stored: PairingRequest = { ...request, id: asUuid(id) };
			this.pairingRequests.set(id, stored);
			ids.push(asUuid(id));
		}
		return ids;
	}

	async updatePairingRequests(requests: PairingRequest[]): Promise<void> {
		for (const request of requests) {
			const existing = this.pairingRequests.get(String(request.id));
			if (existing) {
				this.pairingRequests.set(String(request.id), {
					...existing,
					...request,
				});
			}
		}
	}

	async deletePairingRequests(ids: UUID[]): Promise<void> {
		for (const id of ids) {
			this.pairingRequests.delete(String(id));
		}
	}

	async getPairingAllowlists(
		queries: Array<{ channel: PairingChannel; agentId: UUID }>,
	): Promise<PairingAllowlistsResult> {
		const result: PairingAllowlistsResult = [];
		for (const { channel, agentId } of queries) {
			const entries: PairingAllowlistEntry[] = [];
			for (const entry of this.pairingAllowlist.values()) {
				if (entry.channel === channel && entry.agentId === agentId) {
					entries.push(entry);
				}
			}
			entries.sort(
				(a, b) =>
					new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
			);
			result.push({ channel, agentId, entries });
		}
		return result;
	}

	// Batch pairing allowlist methods
	async createPairingAllowlistEntries(
		entries: PairingAllowlistEntry[],
	): Promise<UUID[]> {
		const ids: UUID[] = [];
		for (const entry of entries) {
			const gen =
				typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
					? crypto.randomUUID()
					: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
			const id = entry.id ? String(entry.id) : gen;
			const stored: PairingAllowlistEntry = { ...entry, id: asUuid(id) };
			this.pairingAllowlist.set(id, stored);
			ids.push(asUuid(id));
		}
		return ids;
	}

	async updatePairingAllowlistEntries(
		entries: PairingAllowlistEntry[],
	): Promise<void> {
		for (const entry of entries) {
			if (!entry.id) continue;
			const id = String(entry.id);
			const existing = this.pairingAllowlist.get(id);
			if (existing) {
				this.pairingAllowlist.set(id, { ...existing, ...entry });
			}
		}
	}

	async deletePairingAllowlistEntries(ids: UUID[]): Promise<void> {
		for (const id of ids) {
			this.pairingAllowlist.delete(String(id));
		}
	}

	async listConnectorAccounts(
		params: ListConnectorAccountsParams = {},
	): Promise<ConnectorAccountRecord[]> {
		const agentId = params.agentId ?? DEFAULT_UUID;
		const offset = params.offset ?? 0;
		const limit = params.limit ?? 100;
		return Array.from(this.connectorAccountsById.values())
			.filter((account) => account.agentId === agentId)
			.filter((account) => account.deletedAt == null)
			.filter(
				(account) => !params.provider || account.provider === params.provider,
			)
			.filter((account) => !params.status || account.status === params.status)
			.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
			.slice(offset, offset + limit)
			.map((account) => ({
				...account,
				scopes: [...account.scopes],
				purpose: [...account.purpose],
				capabilities: [...account.capabilities],
				profile: cloneConnectorJsonObject(account.profile),
				metadata: cloneConnectorJsonObject(account.metadata),
			}));
	}

	async getConnectorAccount(
		params: GetConnectorAccountParams,
	): Promise<ConnectorAccountRecord | null> {
		let account: ConnectorAccountRecord | undefined;
		if (params.id) {
			account = this.connectorAccountsById.get(String(params.id));
		} else {
			if (!params.provider || !params.accountKey) {
				throw new Error(
					"getConnectorAccount requires id or provider + accountKey",
				);
			}
			const key = connectorAccountKey({
				agentId: params.agentId ?? DEFAULT_UUID,
				provider: params.provider,
				accountKey: params.accountKey,
			});
			const accountId = this.connectorAccountIdsByKey.get(key);
			account = accountId
				? this.connectorAccountsById.get(accountId)
				: undefined;
		}
		if (!account || account.deletedAt != null) return null;
		return {
			...account,
			scopes: [...account.scopes],
			purpose: [...account.purpose],
			capabilities: [...account.capabilities],
			profile: cloneConnectorJsonObject(account.profile),
			metadata: cloneConnectorJsonObject(account.metadata),
		};
	}

	async upsertConnectorAccount(
		params: UpsertConnectorAccountParams,
	): Promise<ConnectorAccountRecord> {
		const agentId = params.agentId ?? DEFAULT_UUID;
		const lookupKey = connectorAccountKey({
			agentId,
			provider: params.provider,
			accountKey: params.accountKey,
		});
		const existingId = params.id
			? String(params.id)
			: this.connectorAccountIdsByKey.get(lookupKey);
		const existing = existingId
			? this.connectorAccountsById.get(existingId)
			: undefined;
		const now = Date.now();
		const id = params.id ?? existing?.id ?? randomUuid();
		if (existing) {
			this.connectorAccountIdsByKey.delete(
				connectorAccountKey({
					agentId: existing.agentId,
					provider: existing.provider,
					accountKey: existing.accountKey,
				}),
			);
		}

		const connectedAt = connectorDateToMillis(params.connectedAt);
		const lastSyncAt = connectorDateToMillis(params.lastSyncAt);
		const deletedAt = connectorDateToMillis(params.deletedAt);
		const record: ConnectorAccountRecord = {
			id,
			agentId,
			provider: params.provider,
			accountKey: params.accountKey,
			externalId:
				params.externalId !== undefined
					? params.externalId
					: existing?.externalId,
			displayName:
				params.displayName !== undefined
					? params.displayName
					: existing?.displayName,
			username:
				params.username !== undefined ? params.username : existing?.username,
			email: params.email !== undefined ? params.email : existing?.email,
			ownerBindingId:
				params.ownerBindingId !== undefined
					? params.ownerBindingId
					: existing?.ownerBindingId,
			ownerIdentityId:
				params.ownerIdentityId !== undefined
					? params.ownerIdentityId
					: existing?.ownerIdentityId,
			role: params.role ?? existing?.role ?? "OWNER",
			purpose: params.purpose
				? [...params.purpose]
				: [...(existing?.purpose ?? ["messaging"])],
			accessGate: params.accessGate ?? existing?.accessGate ?? "open",
			status: params.status ?? existing?.status ?? "connected",
			scopes: params.scopes
				? [...params.scopes]
				: [...(existing?.scopes ?? [])],
			capabilities: params.capabilities
				? [...params.capabilities]
				: [...(existing?.capabilities ?? [])],
			profile:
				params.profile !== undefined
					? cloneConnectorJsonObject(params.profile)
					: cloneConnectorJsonObject(existing?.profile),
			metadata:
				params.metadata !== undefined
					? cloneConnectorJsonObject(params.metadata)
					: cloneConnectorJsonObject(existing?.metadata),
			connectedAt: connectedAt ?? existing?.connectedAt ?? now,
			lastSyncAt: lastSyncAt !== undefined ? lastSyncAt : existing?.lastSyncAt,
			deletedAt: deletedAt === undefined ? null : deletedAt,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		this.connectorAccountsById.set(String(id), record);
		this.connectorAccountIdsByKey.set(lookupKey, String(id));
		return this.getConnectorAccount({ id }) as Promise<ConnectorAccountRecord>;
	}

	async deleteConnectorAccount(
		params: DeleteConnectorAccountParams,
	): Promise<boolean> {
		const account = await this.getConnectorAccount(params);
		if (!account) return false;
		const now = Date.now();
		this.connectorAccountsById.set(String(account.id), {
			...account,
			status: "disabled",
			deletedAt: now,
			updatedAt: now,
		});
		this.connectorAccountIdsByKey.delete(
			connectorAccountKey({
				agentId: account.agentId,
				provider: account.provider,
				accountKey: account.accountKey,
			}),
		);
		return true;
	}

	async setConnectorAccountCredentialRef(
		params: SetConnectorAccountCredentialRefParams,
	): Promise<ConnectorAccountCredentialRefRecord> {
		const account = await this.getConnectorAccount({ id: params.accountId });
		if (!account) {
			throw new Error(`Connector account not found: ${params.accountId}`);
		}
		const key = connectorCredentialKey(params);
		const existing = this.connectorCredentialRefs.get(key);
		const now = Date.now();
		const expiresAt = connectorDateToMillis(params.expiresAt);
		const lastVerifiedAt = connectorDateToMillis(params.lastVerifiedAt);
		const record: ConnectorAccountCredentialRefRecord = {
			id: existing?.id ?? randomUuid(),
			accountId: params.accountId,
			agentId: account.agentId,
			provider: account.provider,
			credentialType: params.credentialType,
			vaultRef: params.vaultRef,
			metadata:
				params.metadata !== undefined
					? cloneConnectorJsonObject(params.metadata)
					: cloneConnectorJsonObject(existing?.metadata),
			expiresAt: expiresAt !== undefined ? expiresAt : existing?.expiresAt,
			lastVerifiedAt:
				lastVerifiedAt !== undefined
					? lastVerifiedAt
					: existing?.lastVerifiedAt,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		this.connectorCredentialRefs.set(key, record);
		return {
			...record,
			metadata: cloneConnectorJsonObject(record.metadata),
		};
	}

	async getConnectorAccountCredentialRef(
		params: GetConnectorAccountCredentialRefParams,
	): Promise<ConnectorAccountCredentialRefRecord | null> {
		const account = await this.getConnectorAccount({ id: params.accountId });
		if (!account) return null;
		const credential = this.connectorCredentialRefs.get(
			connectorCredentialKey(params),
		);
		return credential
			? {
					...credential,
					metadata: cloneConnectorJsonObject(credential.metadata),
				}
			: null;
	}

	async listConnectorAccountCredentialRefs(
		params: ListConnectorAccountCredentialRefsParams,
	): Promise<ConnectorAccountCredentialRefRecord[]> {
		const account = await this.getConnectorAccount({ id: params.accountId });
		if (!account) return [];
		return Array.from(this.connectorCredentialRefs.values())
			.filter((credential) => credential.accountId === params.accountId)
			.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
			.map((credential) => ({
				...credential,
				metadata: cloneConnectorJsonObject(credential.metadata),
			}));
	}

	async appendConnectorAccountAuditEvent(
		params: AppendConnectorAccountAuditEventParams,
	): Promise<ConnectorAccountAuditEventRecord> {
		let agentId = params.agentId ?? DEFAULT_UUID;
		let provider = params.provider;
		if (params.accountId && (!params.agentId || !provider)) {
			const account = await this.getConnectorAccount({ id: params.accountId });
			if (!account) {
				throw new Error(`Connector account not found: ${params.accountId}`);
			}
			agentId = account.agentId;
			provider = account.provider;
		}
		if (!provider) {
			throw new Error(
				"appendConnectorAccountAuditEvent requires provider or accountId",
			);
		}
		const record: ConnectorAccountAuditEventRecord = {
			id: randomUuid(),
			accountId: params.accountId ?? null,
			agentId,
			provider,
			actorId: params.actorId ?? null,
			action: params.action,
			outcome:
				params.outcome ?? ("success" satisfies ConnectorAccountAuditOutcome),
			metadata: redactConnectorAuditMetadata(params.metadata),
			createdAt: connectorDateToMillis(params.createdAt) ?? Date.now(),
		};
		this.connectorAuditEvents.push(record);
		return {
			...record,
			metadata: cloneConnectorJsonObject(record.metadata),
		};
	}

	async createOAuthFlowState(
		params: CreateOAuthFlowStateParams,
	): Promise<OAuthFlowRecord> {
		const stateHash = await sha256Hex(params.state);
		const agentId = params.agentId ?? DEFAULT_UUID;
		const key = oauthFlowKey({
			agentId,
			provider: params.provider,
			stateHash,
		});
		const existing = this.oauthFlowsByStateHash.get(key);
		const now = Date.now();
		const expiresAt =
			connectorDateToMillis(params.expiresAt) ??
			now + (params.ttlMs ?? 10 * 60_000);
		const record: OAuthFlowRecord = {
			stateHash,
			agentId,
			provider: params.provider,
			accountId: params.accountId ?? null,
			redirectUri: params.redirectUri ?? null,
			codeVerifierRef: params.codeVerifierRef ?? null,
			scopes: params.scopes ? [...params.scopes] : [],
			metadata: cloneConnectorJsonObject(params.metadata),
			createdAt: existing?.createdAt ?? now,
			expiresAt,
			consumedAt: null,
			consumedBy: null,
		};
		this.oauthFlowsByStateHash.set(key, record);
		return {
			...record,
			scopes: [...record.scopes],
			metadata: cloneConnectorJsonObject(record.metadata),
		};
	}

	async consumeOAuthFlowState(
		params: ConsumeOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null> {
		const existing = await this.findOAuthFlowState(params);
		const now = connectorDateToMillis(params.now) ?? Date.now();
		if (
			!existing ||
			existing.consumedAt != null ||
			existing.expiresAt <= now ||
			(params.agentId && existing.agentId !== params.agentId) ||
			(params.provider && existing.provider !== params.provider)
		) {
			return null;
		}
		const record: OAuthFlowRecord = {
			...existing,
			consumedAt: now,
			consumedBy: params.consumedBy ?? null,
		};
		this.oauthFlowsByStateHash.set(
			oauthFlowKey({
				agentId: record.agentId,
				provider: record.provider,
				stateHash: record.stateHash,
			}),
			record,
		);
		return {
			...record,
			scopes: [...record.scopes],
			metadata: cloneConnectorJsonObject(record.metadata),
		};
	}

	private async findOAuthFlowState(
		params:
			| GetOAuthFlowStateParams
			| UpdateOAuthFlowStateParams
			| DeleteOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null> {
		let stateHash = params.stateHash;
		if (!stateHash && params.state) {
			stateHash = await sha256Hex(params.state);
		}
		const agentId = params.agentId ?? DEFAULT_UUID;
		let existing = stateHash
			? Array.from(this.oauthFlowsByStateHash.values()).find(
					(flow) =>
						flow.stateHash === stateHash &&
						flow.agentId === agentId &&
						(!params.provider || flow.provider === params.provider),
				)
			: undefined;
		if (!existing && params.flowId) {
			existing = Array.from(this.oauthFlowsByStateHash.values()).find(
				(flow) =>
					flow.metadata.flowId === params.flowId &&
					flow.agentId === agentId &&
					(!params.provider || flow.provider === params.provider),
			);
		}
		if (!existing) return null;
		const now =
			connectorDateToMillis((params as GetOAuthFlowStateParams).now) ??
			Date.now();
		const query = params as GetOAuthFlowStateParams;
		if (existing.agentId !== agentId) return null;
		if (params.provider && existing.provider !== params.provider) return null;
		if (!query.includeConsumed && existing.consumedAt != null) return null;
		if (!query.includeExpired && existing.expiresAt <= now) return null;
		return {
			...existing,
			scopes: [...existing.scopes],
			metadata: cloneConnectorJsonObject(existing.metadata),
		};
	}

	async getOAuthFlowState(
		params: GetOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null> {
		return this.findOAuthFlowState(params);
	}

	async updateOAuthFlowState(
		params: UpdateOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null> {
		const existing = await this.findOAuthFlowState({
			...params,
			includeConsumed: true,
			includeExpired: true,
		});
		if (!existing) return null;
		const expiresAt = connectorDateToMillis(params.expiresAt);
		const consumedAt = connectorDateToMillis(params.consumedAt);
		const record: OAuthFlowRecord = {
			...existing,
			accountId:
				params.accountId !== undefined ? params.accountId : existing.accountId,
			redirectUri:
				params.redirectUri !== undefined
					? params.redirectUri
					: existing.redirectUri,
			codeVerifierRef:
				params.codeVerifierRef !== undefined
					? params.codeVerifierRef
					: existing.codeVerifierRef,
			scopes: params.scopes ? [...params.scopes] : [...existing.scopes],
			metadata: {
				...cloneConnectorJsonObject(existing.metadata),
				...(params.metadata ? cloneConnectorJsonObject(params.metadata) : {}),
			},
			expiresAt: expiresAt ?? existing.expiresAt,
			consumedAt:
				params.consumedAt !== undefined ? consumedAt : existing.consumedAt,
			consumedBy:
				params.consumedBy !== undefined
					? params.consumedBy
					: existing.consumedBy,
		};
		this.oauthFlowsByStateHash.set(
			oauthFlowKey({
				agentId: record.agentId,
				provider: record.provider,
				stateHash: record.stateHash,
			}),
			record,
		);
		return {
			...record,
			scopes: [...record.scopes],
			metadata: cloneConnectorJsonObject(record.metadata),
		};
	}

	async deleteOAuthFlowState(
		params: DeleteOAuthFlowStateParams,
	): Promise<boolean> {
		const existing = await this.findOAuthFlowState({
			...params,
			includeConsumed: true,
			includeExpired: true,
		});
		if (!existing) return false;
		return this.oauthFlowsByStateHash.delete(
			oauthFlowKey({
				agentId: existing.agentId,
				provider: existing.provider,
				stateHash: existing.stateHash,
			}),
		);
	}
}
