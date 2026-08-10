/**
 * Connector-account service: the runtime-side registry and policy engine for
 * external-account connectors (chat/social/OAuth providers). The
 * `ConnectorAccountManager` Service holds registered `ConnectorAccountProvider`s,
 * brokers their OAuth start/complete flows, and persists accounts + flow state
 * through a `ConnectorAccountStorage` backend — the in-memory fallback, or the
 * `DatabaseConnectorAccountStorage` bridge when a compatible database adapter is
 * installed on the runtime.
 *
 * `evaluateConnectorAccountPolicies` gates actions that carry a
 * `connectorAccountPolicy`: an action runs only when a stored or
 * provider-listed account satisfies the required status, role, purpose, and
 * access-gate. Role strings collapse to the canonical OWNER / AGENT / TEAM
 * triad (`types/connector-account-policy`); privacy levels live alongside in
 * `privacy.ts`.
 *
 * OAuth PKCE code verifiers are stored only through the host's durable
 * connector credential vault and referenced by an opaque `codeVerifierRef`,
 * so flow rows never carry the raw secret and callbacks survive restarts.
 */
import { logger } from "../logger";
import type { Action, ActionParameters } from "../types/components";
import type {
	ConnectorAccountAccessGate,
	ConnectorAccountPolicy,
	ConnectorAccountPurpose,
	ConnectorAccountRole,
	ConnectorAccountStatus,
} from "../types/connector-account-policy";
import type { Memory, MemoryMetadata } from "../types/memory";
import type { Metadata } from "../types/primitives";
import type {
	IAgentRuntime,
	MessageConnectorRegistration,
	PostConnectorRegistration,
} from "../types/runtime";
import { Service } from "../types/service";

// Re-export the policy types whose canonical home is types/connector-account-policy.
export type {
	ConnectorAccountAccessGate,
	ConnectorAccountPolicy,
	ConnectorAccountPurpose,
	ConnectorAccountRole,
	ConnectorAccountStatus,
} from "../types/connector-account-policy";

export const CONNECTOR_ACCOUNT_SERVICE_TYPE = "connector_account";
export const CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE =
	"connector_account_storage";

export type ConnectorOAuthFlowStatus =
	| "pending"
	| "completed"
	| "failed"
	| "cancelled";

export interface ConnectorAccount {
	id: string;
	provider: string;
	label?: string;
	role: ConnectorAccountRole;
	purpose: ConnectorAccountPurpose[];
	accessGate: ConnectorAccountAccessGate;
	status: ConnectorAccountStatus;
	externalId?: string;
	displayHandle?: string;
	ownerBindingId?: string;
	ownerIdentityId?: string;
	/** OAuth scopes currently granted to this account. */
	scopes?: string[];
	/** Stable connector capabilities derived from the granted scopes. */
	capabilities?: string[];
	/** Provider product surfaces enabled for this account. */
	selectedProducts?: string[];
	/** Product preference when more than one account can satisfy a capability. */
	isDefault?: boolean;
	createdAt: number;
	updatedAt: number;
	metadata?: Metadata;
}

export interface ConnectorAccountPatch {
	label?: string;
	role?: ConnectorAccountRole;
	purpose?: ConnectorAccountPurpose | ConnectorAccountPurpose[];
	accessGate?: ConnectorAccountAccessGate;
	status?: ConnectorAccountStatus;
	externalId?: string | null;
	displayHandle?: string | null;
	ownerBindingId?: string | null;
	ownerIdentityId?: string | null;
	scopes?: string[];
	capabilities?: string[];
	selectedProducts?: string[];
	isDefault?: boolean;
	metadata?: Metadata;
}

export interface ConnectorOAuthFlow {
	id: string;
	provider: string;
	state: string;
	status: ConnectorOAuthFlowStatus;
	accountId?: string;
	authUrl?: string;
	error?: string;
	redirectUri?: string;
	codeVerifier?: string;
	createdAt: number;
	updatedAt: number;
	expiresAt?: number;
	metadata?: Metadata;
}

export interface ConnectorOAuthStartRequest {
	provider: string;
	flow: ConnectorOAuthFlow;
	redirectUri?: string;
	accountId?: string;
	label?: string;
	scopes?: string[];
	metadata?: Metadata;
}

export interface ConnectorOAuthStartResult {
	authUrl: string;
	expiresAt?: number;
	codeVerifier?: string;
	metadata?: Metadata;
}

export interface ConnectorOAuthCallbackRequest {
	provider: string;
	flow: ConnectorOAuthFlow;
	code?: string;
	error?: string;
	errorDescription?: string;
	query: Record<string, string>;
	body?: Record<string, unknown>;
}

export interface ConnectorOAuthCallbackResult {
	account?: ConnectorAccount | ConnectorAccountPatch;
	flow?: Partial<ConnectorOAuthFlow>;
	redirectUrl?: string;
	metadata?: Metadata;
}

export interface ConnectorAccountProvider {
	provider: string;
	label?: string;
	messageConnector?: MessageConnectorRegistration;
	postConnector?: PostConnectorRegistration;
	listAccounts?: (
		manager: ConnectorAccountManager,
	) => Promise<ConnectorAccount[]> | ConnectorAccount[];
	createAccount?: (
		input: ConnectorAccountPatch,
		manager: ConnectorAccountManager,
	) => Promise<ConnectorAccount | ConnectorAccountPatch>;
	patchAccount?: (
		accountId: string,
		patch: ConnectorAccountPatch,
		manager: ConnectorAccountManager,
	) => Promise<ConnectorAccount | ConnectorAccountPatch>;
	deleteAccount?: (
		accountId: string,
		manager: ConnectorAccountManager,
	) => Promise<void>;
	startOAuth?: (
		request: ConnectorOAuthStartRequest,
		manager: ConnectorAccountManager,
	) => Promise<ConnectorOAuthStartResult>;
	completeOAuth?: (
		request: ConnectorOAuthCallbackRequest,
		manager: ConnectorAccountManager,
	) => Promise<ConnectorOAuthCallbackResult>;
	afterAccountUpsert?: (
		account: ConnectorAccount,
		reason: "create" | "patch" | "oauth",
		manager: ConnectorAccountManager,
	) => Promise<void> | void;
}

export interface ConnectorAccountProviderRegistrationResult {
	provider: string;
	messageConnectorRegistered: boolean;
	messageConnectorSkipped: boolean;
	postConnectorRegistered: boolean;
	postConnectorSkipped: boolean;
}

export interface ConnectorOwnerBindingLookup {
	connector: string;
	externalId: string;
	instanceId?: string;
}

export interface ConnectorOwnerBindingRecord {
	id: string;
	identityId: string;
	connector: string;
	externalId: string;
	displayHandle: string;
	instanceId: string;
	verifiedAt: number;
}

export interface ConnectorAccountStorage {
	listAccounts(provider?: string): Promise<ConnectorAccount[]>;
	getAccount(
		provider: string,
		accountId: string,
	): Promise<ConnectorAccount | null>;
	upsertAccount(account: ConnectorAccount): Promise<ConnectorAccount>;
	deleteAccount(provider: string, accountId: string): Promise<boolean>;
	createOAuthFlow(flow: ConnectorOAuthFlow): Promise<ConnectorOAuthFlow>;
	getOAuthFlow(
		provider: string,
		flowIdOrState: string,
	): Promise<ConnectorOAuthFlow | null>;
	consumeOAuthFlow(
		provider: string,
		state: string,
		consumedBy?: string,
	): Promise<ConnectorOAuthFlow | null>;
	updateOAuthFlow(
		provider: string,
		flowIdOrState: string,
		patch: Partial<ConnectorOAuthFlow>,
	): Promise<ConnectorOAuthFlow | null>;
	deleteOAuthFlow(provider: string, flowIdOrState: string): Promise<boolean>;
	findOwnerBinding?(
		lookup: ConnectorOwnerBindingLookup,
	): Promise<ConnectorOwnerBindingRecord | null>;
}

interface ConnectorAccountDatabaseAdapter {
	listConnectorAccounts(params?: {
		agentId?: string;
		provider?: string;
		status?: string;
		limit?: number;
		offset?: number;
	}): Promise<ConnectorAccountDatabaseRecord[]>;
	getConnectorAccount(params: {
		agentId?: string;
		id?: string;
		provider?: string;
		accountKey?: string;
	}): Promise<ConnectorAccountDatabaseRecord | null>;
	upsertConnectorAccount(params: {
		agentId?: string;
		id?: string;
		provider: string;
		accountKey: string;
		externalId?: string | null;
		displayName?: string | null;
		username?: string | null;
		email?: string | null;
		ownerBindingId?: string | null;
		ownerIdentityId?: string | null;
		role?: string;
		purpose?: string[];
		accessGate?: string;
		status?: string;
		scopes?: string[];
		capabilities?: string[];
		metadata?: Metadata;
		connectedAt?: number;
	}): Promise<ConnectorAccountDatabaseRecord>;
	deleteConnectorAccount(params: {
		agentId?: string;
		id?: string;
		provider?: string;
		accountKey?: string;
	}): Promise<boolean>;
	listConnectorAccountCredentialRefs?(params: {
		accountId: string;
	}): Promise<Array<{ vaultRef: string }>>;
	deleteConnectorAccountCredentialRefs?(params: {
		accountId: string;
	}): Promise<number>;
	findConnectorOwnerBinding?(
		lookup: ConnectorOwnerBindingLookup,
	): Promise<ConnectorOwnerBindingRecord | null>;
	createOAuthFlowState?(params: {
		state: string;
		provider: string;
		accountId?: string | null;
		redirectUri?: string | null;
		codeVerifierRef?: string | null;
		scopes?: string[];
		metadata?: Record<string, unknown>;
		ttlMs?: number;
		expiresAt?: number | Date;
	}): Promise<ConnectorOAuthDatabaseRecord>;
	consumeOAuthFlowState?(params: {
		state: string;
		provider?: string;
		consumedBy?: string | null;
		now?: number | Date;
	}): Promise<ConnectorOAuthDatabaseRecord | null>;
	getOAuthFlowState?(params: {
		state?: string;
		stateHash?: string;
		flowId?: string;
		provider?: string;
		includeConsumed?: boolean;
		includeExpired?: boolean;
		now?: number | Date;
	}): Promise<ConnectorOAuthDatabaseRecord | null>;
	updateOAuthFlowState?(params: {
		state?: string;
		stateHash?: string;
		flowId?: string;
		provider?: string;
		accountId?: string | null;
		redirectUri?: string | null;
		codeVerifierRef?: string | null;
		scopes?: string[];
		metadata?: Record<string, unknown>;
		expiresAt?: number | Date;
		consumedAt?: number | Date | null;
		consumedBy?: string | null;
	}): Promise<ConnectorOAuthDatabaseRecord | null>;
	deleteOAuthFlowState?(params: {
		state?: string;
		stateHash?: string;
		flowId?: string;
		provider?: string;
	}): Promise<boolean>;
}

interface ConnectorAccountDatabaseRecord {
	id: string;
	provider: string;
	accountKey: string;
	externalId?: string | null;
	displayName?: string | null;
	username?: string | null;
	email?: string | null;
	ownerBindingId?: string | null;
	ownerIdentityId?: string | null;
	role?: string;
	purpose?: string[];
	accessGate?: string;
	status?: string;
	scopes?: string[];
	capabilities?: string[];
	metadata?: Metadata;
	createdAt?: number;
	updatedAt?: number;
}

interface ConnectorOAuthDatabaseRecord {
	stateHash: string;
	provider: string;
	accountId?: string | null;
	redirectUri?: string | null;
	codeVerifierRef?: string | null;
	scopes?: string[];
	metadata?: Record<string, unknown>;
	createdAt?: number;
	expiresAt?: number;
	consumedAt?: number | null;
	consumedBy?: string | null;
}

export interface ConnectorAccountPolicyContext {
	message?: Memory;
	parameters?: ActionParameters | Record<string, unknown>;
	accountId?: string;
	purpose?: ConnectorAccountPurpose;
}

export interface ConnectorAccountPolicyEvaluation {
	allowed: boolean;
	reason?: string;
	provider?: string;
	account?: ConnectorAccount;
	policy?: ConnectorAccountPolicy;
}

type ActionWithConnectorAccountPolicy = Action & {
	connectorAccountPolicy?:
		| ConnectorAccountPolicy
		| readonly ConnectorAccountPolicy[];
	accountPolicy?: ConnectorAccountPolicy | readonly ConnectorAccountPolicy[];
};

const runtimeManagers = new WeakMap<IAgentRuntime, ConnectorAccountManager>();
let standaloneManager: ConnectorAccountManager | null = null;
const CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPE = "connector_credential_store";

interface ConnectorOAuthCredentialStore {
	putSecret(params: {
		vaultRef?: string;
		agentId: string;
		provider: string;
		accountId: string;
		credentialType: string;
		value: string;
		caller?: string;
	}): Promise<string>;
	reveal?(vaultRef: string, caller?: string): Promise<string>;
	remove?(vaultRef: string): Promise<void>;
}

function nowMs(): number {
	return Date.now();
}

function randomId(prefix: string): string {
	return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

function normalizeProvider(provider: string): string {
	return provider.trim().toLowerCase();
}

function looksLikeUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}

function normalizeStringArray<T extends string>(
	value: T | T[] | undefined,
): T[] {
	if (Array.isArray(value)) {
		return value.map((item) => item.trim()).filter(Boolean) as T[];
	}
	if (typeof value === "string" && value.trim()) {
		return [value.trim() as T];
	}
	return [];
}

function normalizeConnectorAccountRole(
	role: ConnectorAccountRole | undefined,
): ConnectorAccountRole {
	const normalized =
		typeof role === "string" && role.trim()
			? role.trim().toUpperCase()
			: "OWNER";
	switch (normalized) {
		case "OWNER":
			return "OWNER";
		case "AGENT":
		case "SERVICE":
			return "AGENT";
		case "TEAM":
		case "ADMIN":
		case "MEMBER":
		case "VIEWER":
			return "TEAM";
		default:
			return normalized as ConnectorAccountRole;
	}
}

function cloneMetadata(metadata: Metadata | undefined): Metadata | undefined {
	return metadata ? ({ ...metadata } as Metadata) : undefined;
}

function cloneArr<T>(values: readonly T[] | undefined): T[] | undefined {
	return values ? [...values] : undefined;
}

function firstArr<T>(
	primary: readonly T[] | undefined,
	fallback: readonly T[] | undefined,
): T[] | undefined {
	return cloneArr(primary) ?? cloneArr(fallback);
}

const CONNECTOR_BINDING_METADATA_KEY = "connectorBinding";

function readConnectorBindingMetadata(metadata: Metadata | undefined): {
	selectedProducts?: string[];
	isDefault?: boolean;
} {
	const value = metadata?.[CONNECTOR_BINDING_METADATA_KEY];
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const binding = value as Record<string, unknown>;
	return {
		...(Array.isArray(binding.selectedProducts)
			? { selectedProducts: normalizeStringArray(binding.selectedProducts) }
			: {}),
		...(typeof binding.isDefault === "boolean"
			? { isDefault: binding.isDefault }
			: {}),
	};
}

function connectorAccountMetadata(
	account: ConnectorAccount,
): Metadata | undefined {
	const metadata = cloneMetadata(account.metadata) ?? {};
	const existing = metadata[CONNECTOR_BINDING_METADATA_KEY];
	const binding =
		existing && typeof existing === "object" && !Array.isArray(existing)
			? ({ ...(existing as Metadata) } as Metadata)
			: ({} as Metadata);
	if (account.selectedProducts) {
		binding.selectedProducts = [...account.selectedProducts];
	}
	if (typeof account.isDefault === "boolean") {
		binding.isDefault = account.isDefault;
	}
	if (Object.keys(binding).length > 0) {
		metadata[CONNECTOR_BINDING_METADATA_KEY] = binding;
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function cloneAccount(account: ConnectorAccount): ConnectorAccount {
	return {
		...account,
		purpose: [...account.purpose],
		scopes: cloneArr(account.scopes),
		capabilities: cloneArr(account.capabilities),
		selectedProducts: cloneArr(account.selectedProducts),
		isDefault: account.isDefault,
		metadata: cloneMetadata(account.metadata),
	};
}

function mergeStoredAndProviderAccount(
	stored: ConnectorAccount,
	providerAccount: ConnectorAccount,
): ConnectorAccount {
	return {
		...providerAccount,
		id: stored.id,
		provider: stored.provider,
		label: stored.label ?? providerAccount.label,
		role: stored.role,
		purpose: [...stored.purpose],
		accessGate: stored.accessGate,
		status: stored.status,
		externalId: stored.externalId ?? providerAccount.externalId,
		displayHandle: stored.displayHandle ?? providerAccount.displayHandle,
		ownerBindingId: stored.ownerBindingId ?? providerAccount.ownerBindingId,
		ownerIdentityId: stored.ownerIdentityId ?? providerAccount.ownerIdentityId,
		scopes: firstArr(stored.scopes, providerAccount.scopes),
		capabilities: firstArr(stored.capabilities, providerAccount.capabilities),
		selectedProducts: firstArr(
			stored.selectedProducts,
			providerAccount.selectedProducts,
		),
		isDefault: stored.isDefault ?? providerAccount.isDefault,
		createdAt: stored.createdAt,
		updatedAt: Math.max(stored.updatedAt, providerAccount.updatedAt),
		metadata: {
			...(cloneMetadata(providerAccount.metadata) ?? {}),
			...(cloneMetadata(stored.metadata) ?? {}),
		},
	};
}

function cloneFlow(flow: ConnectorOAuthFlow): ConnectorOAuthFlow {
	return {
		...flow,
		metadata: cloneMetadata(flow.metadata),
	};
}

function normalizeAccount(
	input: ConnectorAccount | ConnectorAccountPatch,
	provider: string,
	accountId?: string,
): ConnectorAccount {
	const now = nowMs();
	const full = input as Partial<ConnectorAccount>;
	const bindingMetadata = readConnectorBindingMetadata(full.metadata);
	const id = (full.id ?? accountId ?? "").trim();
	if (!id) {
		throw new Error("Connector account requires an id");
	}
	const normalizedProvider = normalizeProvider(full.provider ?? provider);
	if (!normalizedProvider) {
		throw new Error("Connector account requires a provider");
	}
	return {
		id,
		provider: normalizedProvider,
		label: typeof full.label === "string" ? full.label : undefined,
		role: normalizeConnectorAccountRole(full.role),
		purpose: normalizeStringArray(full.purpose),
		accessGate: (full.accessGate ?? "open") as ConnectorAccountAccessGate,
		status: (full.status ?? "connected") as ConnectorAccountStatus,
		externalId:
			typeof full.externalId === "string" && full.externalId
				? full.externalId
				: undefined,
		displayHandle:
			typeof full.displayHandle === "string" && full.displayHandle
				? full.displayHandle
				: undefined,
		ownerBindingId:
			typeof full.ownerBindingId === "string" && full.ownerBindingId
				? full.ownerBindingId
				: undefined,
		ownerIdentityId:
			typeof full.ownerIdentityId === "string" && full.ownerIdentityId
				? full.ownerIdentityId
				: undefined,
		scopes: full.scopes ? normalizeStringArray(full.scopes) : undefined,
		capabilities: full.capabilities
			? normalizeStringArray(full.capabilities)
			: undefined,
		selectedProducts: full.selectedProducts
			? normalizeStringArray(full.selectedProducts)
			: bindingMetadata.selectedProducts,
		isDefault:
			typeof full.isDefault === "boolean"
				? full.isDefault
				: bindingMetadata.isDefault,
		createdAt: typeof full.createdAt === "number" ? full.createdAt : now,
		updatedAt: now,
		metadata: cloneMetadata(full.metadata),
	};
}

function mergeAccountPatch(
	account: ConnectorAccount,
	patch: ConnectorAccountPatch,
): ConnectorAccount {
	return normalizeAccount(
		{
			...account,
			...patch,
			provider: account.provider,
			id: account.id,
			purpose:
				patch.purpose !== undefined
					? normalizeStringArray(patch.purpose)
					: account.purpose,
			externalId:
				patch.externalId === null
					? undefined
					: (patch.externalId ?? account.externalId),
			displayHandle:
				patch.displayHandle === null
					? undefined
					: (patch.displayHandle ?? account.displayHandle),
			ownerBindingId:
				patch.ownerBindingId === null
					? undefined
					: (patch.ownerBindingId ?? account.ownerBindingId),
			ownerIdentityId:
				patch.ownerIdentityId === null
					? undefined
					: (patch.ownerIdentityId ?? account.ownerIdentityId),
			scopes: patch.scopes ?? account.scopes,
			capabilities: patch.capabilities ?? account.capabilities,
			selectedProducts: patch.selectedProducts ?? account.selectedProducts,
			isDefault: patch.isDefault ?? account.isDefault,
			createdAt: account.createdAt,
			metadata:
				patch.metadata !== undefined ? patch.metadata : account.metadata,
		},
		account.provider,
		account.id,
	);
}

export function isConnectorAccountStorage(
	value: unknown,
): value is ConnectorAccountStorage {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ConnectorAccountStorage>;
	return (
		typeof candidate.listAccounts === "function" &&
		typeof candidate.getAccount === "function" &&
		typeof candidate.upsertAccount === "function" &&
		typeof candidate.deleteAccount === "function" &&
		typeof candidate.createOAuthFlow === "function" &&
		typeof candidate.getOAuthFlow === "function" &&
		typeof candidate.updateOAuthFlow === "function" &&
		typeof candidate.deleteOAuthFlow === "function"
	);
}

/**
 * In-memory fallback for tests and hosts without a durable connector-account
 * storage service. Production runtimes resolve durable storage through an
 * installed ConnectorAccountStorage service or the database adapter bridge.
 */
export class InMemoryConnectorAccountStorage
	implements ConnectorAccountStorage
{
	private accounts = new Map<string, ConnectorAccount>();
	private flows = new Map<string, ConnectorOAuthFlow>();
	private consumedFlows = new Set<string>();
	private ownerBindings = new Map<string, ConnectorOwnerBindingRecord>();

	async listAccounts(provider?: string): Promise<ConnectorAccount[]> {
		const normalized = provider ? normalizeProvider(provider) : undefined;
		return Array.from(this.accounts.values())
			.filter((account) => !normalized || account.provider === normalized)
			.map(cloneAccount)
			.sort(
				(a, b) =>
					a.provider.localeCompare(b.provider) ||
					a.createdAt - b.createdAt ||
					a.id.localeCompare(b.id),
			);
	}

	async getAccount(
		provider: string,
		accountId: string,
	): Promise<ConnectorAccount | null> {
		const account = this.accounts.get(accountKey(provider, accountId));
		return account ? cloneAccount(account) : null;
	}

	async upsertAccount(account: ConnectorAccount): Promise<ConnectorAccount> {
		const normalized = normalizeAccount(account, account.provider, account.id);
		this.accounts.set(
			accountKey(normalized.provider, normalized.id),
			normalized,
		);
		return cloneAccount(normalized);
	}

	async deleteAccount(provider: string, accountId: string): Promise<boolean> {
		return this.accounts.delete(accountKey(provider, accountId));
	}

	async createOAuthFlow(flow: ConnectorOAuthFlow): Promise<ConnectorOAuthFlow> {
		const cloned = cloneFlow(flow);
		this.flows.set(flowKey(cloned.provider, cloned.id), cloned);
		this.flows.set(flowKey(cloned.provider, cloned.state), cloned);
		return cloneFlow(cloned);
	}

	async getOAuthFlow(
		provider: string,
		flowIdOrState: string,
	): Promise<ConnectorOAuthFlow | null> {
		const flow = this.flows.get(flowKey(provider, flowIdOrState));
		return flow ? cloneFlow(flow) : null;
	}

	async updateOAuthFlow(
		provider: string,
		flowIdOrState: string,
		patch: Partial<ConnectorOAuthFlow>,
	): Promise<ConnectorOAuthFlow | null> {
		const existing = this.flows.get(flowKey(provider, flowIdOrState));
		if (!existing) return null;
		const next: ConnectorOAuthFlow = {
			...existing,
			...patch,
			provider: existing.provider,
			id: existing.id,
			state: existing.state,
			updatedAt: nowMs(),
			metadata:
				patch.metadata !== undefined
					? cloneMetadata(patch.metadata)
					: cloneMetadata(existing.metadata),
		};
		this.flows.set(flowKey(next.provider, next.id), next);
		this.flows.set(flowKey(next.provider, next.state), next);
		return cloneFlow(next);
	}

	async consumeOAuthFlow(
		provider: string,
		state: string,
		_consumedBy?: string,
	): Promise<ConnectorOAuthFlow | null> {
		const key = flowKey(provider, state);
		if (this.consumedFlows.has(key)) return null;
		const flow = this.flows.get(key);
		if (flow?.status !== "pending") return null;
		if (flow.expiresAt && flow.expiresAt <= nowMs()) return null;
		this.consumedFlows.add(flowKey(flow.provider, flow.id));
		this.consumedFlows.add(flowKey(flow.provider, flow.state));
		return cloneFlow(flow);
	}

	async deleteOAuthFlow(
		provider: string,
		flowIdOrState: string,
	): Promise<boolean> {
		const existing = this.flows.get(flowKey(provider, flowIdOrState));
		if (!existing) return false;
		this.flows.delete(flowKey(existing.provider, existing.id));
		this.flows.delete(flowKey(existing.provider, existing.state));
		this.consumedFlows.delete(flowKey(existing.provider, existing.id));
		this.consumedFlows.delete(flowKey(existing.provider, existing.state));
		return true;
	}

	async findOwnerBinding(
		lookup: ConnectorOwnerBindingLookup,
	): Promise<ConnectorOwnerBindingRecord | null> {
		const normalized = ownerBindingKey(
			lookup.connector,
			lookup.externalId,
			lookup.instanceId,
		);
		const binding = this.ownerBindings.get(normalized);
		return binding ? { ...binding } : null;
	}

	/** True when this fallback holds boot-window state that must be handed off. */
	hasStateForMigration(): boolean {
		return this.accounts.size > 0 || this.flows.size > 0;
	}

	/**
	 * Read-only snapshot of migratable state: every account plus each unique
	 * pending, unexpired OAuth flow (the flows map stores every flow under both
	 * its id and state keys). Consumed-but-in-flight flows — consumed here while
	 * their `completeOAuth` awaits the provider — are returned separately so the
	 * handoff can reconstruct the consumed marker in the durable backend; the
	 * terminal `updateOAuthFlow` after the provider resolves must still find
	 * them.
	 */
	snapshotForMigration(): {
		accounts: ConnectorAccount[];
		flows: ConnectorOAuthFlow[];
		consumedPendingFlows: ConnectorOAuthFlow[];
	} {
		const accounts = Array.from(this.accounts.values()).map(cloneAccount);
		const flows: ConnectorOAuthFlow[] = [];
		const consumedPendingFlows: ConnectorOAuthFlow[] = [];
		const seen = new Set<string>();
		for (const flow of this.flows.values()) {
			const key = flowKey(flow.provider, flow.id);
			if (seen.has(key)) continue;
			seen.add(key);
			if (flow.status !== "pending") continue;
			if (flow.expiresAt && flow.expiresAt <= nowMs()) continue;
			if (this.consumedFlows.has(key)) {
				consumedPendingFlows.push(cloneFlow(flow));
			} else {
				flows.push(cloneFlow(flow));
			}
		}
		return { accounts, flows, consumedPendingFlows };
	}

	/** Drop all migratable state after a successful durable handoff. */
	clearAfterMigration(): void {
		this.accounts.clear();
		this.flows.clear();
		this.consumedFlows.clear();
	}

	upsertOwnerBindingForTest(binding: ConnectorOwnerBindingRecord): void {
		this.ownerBindings.set(
			ownerBindingKey(
				binding.connector,
				binding.externalId,
				binding.instanceId,
			),
			{ ...binding },
		);
	}
}

class DatabaseConnectorAccountStorage implements ConnectorAccountStorage {
	private oauthFallback = new InMemoryConnectorAccountStorage();

	constructor(
		private readonly adapter: ConnectorAccountDatabaseAdapter,
		private readonly agentId: string,
	) {}

	async listAccounts(provider?: string): Promise<ConnectorAccount[]> {
		const records = await this.adapter.listConnectorAccounts({
			agentId: this.agentId,
			provider: provider ? normalizeProvider(provider) : undefined,
			limit: 500,
		});
		return records.map(databaseRecordToAccount);
	}

	async getAccount(
		provider: string,
		accountId: string,
	): Promise<ConnectorAccount | null> {
		if (looksLikeUuid(accountId)) {
			const byId = await this.adapter.getConnectorAccount({
				agentId: this.agentId,
				id: accountId,
			});
			if (
				byId &&
				normalizeProvider(byId.provider) === normalizeProvider(provider)
			) {
				return databaseRecordToAccount(byId);
			}
		}
		const byKey = await this.adapter.getConnectorAccount({
			agentId: this.agentId,
			provider: normalizeProvider(provider),
			accountKey: accountId,
		});
		return byKey ? databaseRecordToAccount(byKey) : null;
	}

	async upsertAccount(account: ConnectorAccount): Promise<ConnectorAccount> {
		const record = await this.adapter.upsertConnectorAccount({
			agentId: this.agentId,
			...(looksLikeUuid(account.id) ? { id: account.id } : {}),
			provider: normalizeProvider(account.provider),
			accountKey: account.externalId ?? account.id,
			externalId: account.externalId ?? null,
			displayName: account.label ?? null,
			username: account.displayHandle ?? null,
			ownerBindingId: account.ownerBindingId ?? null,
			ownerIdentityId: account.ownerIdentityId ?? null,
			role: account.role,
			purpose: [...account.purpose],
			accessGate: account.accessGate,
			status: account.status,
			scopes: account.scopes ? [...account.scopes] : undefined,
			capabilities: account.capabilities
				? [...account.capabilities]
				: undefined,
			metadata: connectorAccountMetadata(account),
			connectedAt: account.createdAt,
		});
		return databaseRecordToAccount(record);
	}

	async deleteAccount(provider: string, accountId: string): Promise<boolean> {
		const account = await this.getAccount(provider, accountId);
		return this.adapter.deleteConnectorAccount(
			account
				? { agentId: this.agentId, id: account.id }
				: {
						agentId: this.agentId,
						provider: normalizeProvider(provider),
						accountKey: accountId,
					},
		);
	}

	async findOwnerBinding(
		lookup: ConnectorOwnerBindingLookup,
	): Promise<ConnectorOwnerBindingRecord | null> {
		if (typeof this.adapter.findConnectorOwnerBinding !== "function") {
			return null;
		}
		return this.adapter.findConnectorOwnerBinding({
			connector: normalizeProvider(lookup.connector),
			externalId: lookup.externalId,
			instanceId: lookup.instanceId,
		});
	}

	async createOAuthFlow(flow: ConnectorOAuthFlow): Promise<ConnectorOAuthFlow> {
		await this.oauthFallback.createOAuthFlow(flow);
		if (typeof this.adapter.createOAuthFlowState !== "function") {
			return cloneFlow(flow);
		}
		const record = await this.adapter.createOAuthFlowState({
			state: flow.state,
			provider: normalizeProvider(flow.provider),
			accountId:
				flow.accountId && looksLikeUuid(flow.accountId) ? flow.accountId : null,
			redirectUri: flow.redirectUri ?? null,
			codeVerifierRef: stringMetadataValue(flow.metadata, "codeVerifierRef"),
			metadata: oauthFlowMetadata(flow),
			expiresAt: flow.expiresAt,
		});
		return databaseRecordToOAuthFlow(record, flow.state, flow);
	}

	async getOAuthFlow(
		provider: string,
		flowIdOrState: string,
	): Promise<ConnectorOAuthFlow | null> {
		const normalizedProvider = normalizeProvider(provider);
		const fallback = await this.oauthFallback.getOAuthFlow(
			normalizedProvider,
			flowIdOrState,
		);
		if (typeof this.adapter.getOAuthFlowState !== "function") {
			return fallback;
		}
		const byFlowId = await this.adapter.getOAuthFlowState({
			provider: normalizedProvider,
			flowId: flowIdOrState,
			includeConsumed: true,
			includeExpired: true,
		});
		const record =
			byFlowId ??
			(await this.adapter.getOAuthFlowState({
				provider: normalizedProvider,
				state: flowIdOrState,
				includeConsumed: true,
				includeExpired: true,
			}));
		return record
			? databaseRecordToOAuthFlow(record, flowIdOrState, fallback ?? undefined)
			: fallback;
	}

	async updateOAuthFlow(
		provider: string,
		flowIdOrState: string,
		patch: Partial<ConnectorOAuthFlow>,
	): Promise<ConnectorOAuthFlow | null> {
		const normalizedProvider = normalizeProvider(provider);
		const fallback = await this.oauthFallback.updateOAuthFlow(
			normalizedProvider,
			flowIdOrState,
			patch,
		);
		if (typeof this.adapter.updateOAuthFlowState !== "function") {
			return fallback;
		}
		const metadata = oauthFlowPatchMetadata(patch);
		const metadataCodeVerifierRef = stringMetadataValue(
			patch.metadata,
			"codeVerifierRef",
		);
		const codeVerifierRef = metadataCodeVerifierRef;
		if (codeVerifierRef) {
			metadata.codeVerifierRef = codeVerifierRef;
		}
		const update = {
			provider: normalizedProvider,
			...(patch.accountId !== undefined &&
			patch.accountId &&
			looksLikeUuid(patch.accountId)
				? { accountId: patch.accountId }
				: {}),
			...(patch.redirectUri !== undefined
				? { redirectUri: patch.redirectUri }
				: {}),
			...(codeVerifierRef !== undefined
				? {
						codeVerifierRef,
					}
				: {}),
			...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
			metadata,
		};
		const record =
			(await this.adapter.updateOAuthFlowState({
				...update,
				flowId: flowIdOrState,
			})) ??
			(await this.adapter.updateOAuthFlowState({
				...update,
				state: flowIdOrState,
			}));
		return record
			? databaseRecordToOAuthFlow(record, flowIdOrState, fallback ?? undefined)
			: fallback;
	}

	async consumeOAuthFlow(
		provider: string,
		state: string,
		consumedBy?: string,
	): Promise<ConnectorOAuthFlow | null> {
		const normalizedProvider = normalizeProvider(provider);
		if (typeof this.adapter.consumeOAuthFlowState !== "function") {
			return this.oauthFallback.consumeOAuthFlow(
				normalizedProvider,
				state,
				consumedBy,
			);
		}
		const fallback = await this.oauthFallback.getOAuthFlow(
			normalizedProvider,
			state,
		);
		const record = await this.adapter.consumeOAuthFlowState({
			provider: normalizedProvider,
			state,
			consumedBy: consumedBy ?? null,
		});
		return record
			? databaseRecordToOAuthFlow(record, state, fallback ?? undefined)
			: null;
	}

	async deleteOAuthFlow(
		provider: string,
		flowIdOrState: string,
	): Promise<boolean> {
		const normalizedProvider = normalizeProvider(provider);
		const fallbackDeleted = await this.oauthFallback.deleteOAuthFlow(
			normalizedProvider,
			flowIdOrState,
		);
		if (typeof this.adapter.deleteOAuthFlowState !== "function") {
			return fallbackDeleted;
		}
		const dbDeleted =
			(await this.adapter.deleteOAuthFlowState({
				provider: normalizedProvider,
				flowId: flowIdOrState,
			})) ||
			(await this.adapter.deleteOAuthFlowState({
				provider: normalizedProvider,
				state: flowIdOrState,
			}));
		return fallbackDeleted || dbDeleted;
	}
}

function isConnectorAccountDatabaseAdapter(
	value: unknown,
): value is ConnectorAccountDatabaseAdapter {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ConnectorAccountDatabaseAdapter>;
	return (
		typeof candidate.listConnectorAccounts === "function" &&
		typeof candidate.getConnectorAccount === "function" &&
		typeof candidate.upsertConnectorAccount === "function" &&
		typeof candidate.deleteConnectorAccount === "function"
	);
}

function stringMetadataValue(
	metadata: Metadata | Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function oauthCodeVerifierRef(provider: string, flowId: string): string {
	return `connector-oauth-pkce:${normalizeProvider(provider)}:${flowId}`;
}

function isConnectorOAuthCredentialStore(
	value: unknown,
): value is ConnectorOAuthCredentialStore {
	if (!value || typeof value !== "object") return false;
	return (
		typeof (value as Partial<ConnectorOAuthCredentialStore>).putSecret ===
		"function"
	);
}

function safeOAuthMetadata(
	metadata: Metadata | Record<string, unknown> | undefined,
): Metadata {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata ?? {})) {
		if (
			key === "codeVerifier" ||
			key === "code_verifier" ||
			key === "oauthCodeVerifier"
		) {
			continue;
		}
		cleaned[key] = value;
	}
	return cleaned as Metadata;
}

function oauthFlowMetadata(flow: ConnectorOAuthFlow): Record<string, unknown> {
	const metadata: Record<string, unknown> = {
		...safeOAuthMetadata(flow.metadata),
		flowId: flow.id,
		status: flow.status,
		updatedAt: flow.updatedAt,
	};
	if (flow.authUrl) metadata.authUrl = flow.authUrl;
	if (flow.error) metadata.error = flow.error;
	if (flow.codeVerifier) {
		metadata.hasCodeVerifier = true;
	}
	return metadata;
}

function oauthFlowPatchMetadata(
	patch: Partial<ConnectorOAuthFlow>,
): Record<string, unknown> {
	const metadata: Record<string, unknown> = {
		...safeOAuthMetadata(patch.metadata),
		updatedAt: nowMs(),
	};
	if (patch.id) metadata.flowId = patch.id;
	if (patch.status) metadata.status = patch.status;
	if (patch.authUrl !== undefined) metadata.authUrl = patch.authUrl;
	if (patch.error !== undefined) metadata.error = patch.error;
	if (patch.codeVerifier) {
		metadata.hasCodeVerifier = true;
	}
	return metadata;
}

function databaseRecordToAccount(
	record: ConnectorAccountDatabaseRecord,
): ConnectorAccount {
	const now = nowMs();
	const metadata = cloneMetadata(record.metadata);
	const bindingMetadata = readConnectorBindingMetadata(metadata);
	const status =
		record.status === "active"
			? "connected"
			: ((record.status ?? "connected") as ConnectorAccountStatus);
	return {
		id: record.id,
		provider: normalizeProvider(record.provider),
		label:
			record.displayName ??
			record.email ??
			record.username ??
			record.externalId ??
			record.accountKey,
		role: normalizeConnectorAccountRole(record.role as ConnectorAccountRole),
		purpose: normalizeStringArray(
			(record.purpose ?? ["messaging"]) as ConnectorAccountPurpose[],
		),
		accessGate: (record.accessGate ?? "open") as ConnectorAccountAccessGate,
		status,
		externalId: record.externalId ?? record.accountKey,
		displayHandle: record.username ?? record.email ?? undefined,
		ownerBindingId: record.ownerBindingId ?? undefined,
		ownerIdentityId: record.ownerIdentityId ?? undefined,
		scopes: cloneArr(record.scopes),
		capabilities: cloneArr(record.capabilities),
		selectedProducts: bindingMetadata.selectedProducts,
		isDefault: bindingMetadata.isDefault,
		createdAt: record.createdAt ?? now,
		updatedAt: record.updatedAt ?? now,
		metadata,
	};
}

function databaseRecordToOAuthFlow(
	record: ConnectorOAuthDatabaseRecord,
	lookupValue?: string,
	fallback?: ConnectorOAuthFlow,
): ConnectorOAuthFlow {
	const now = nowMs();
	const metadata = (record.metadata ?? {}) as Metadata;
	const flowId =
		stringMetadataValue(metadata, "flowId") ??
		fallback?.id ??
		(lookupValue?.startsWith("oauth_")
			? lookupValue
			: `oauth_${record.stateHash.slice(0, 16)}`);
	const state =
		fallback?.state ??
		(lookupValue && !lookupValue.startsWith("oauth_")
			? lookupValue
			: record.stateHash);
	const statusValue =
		stringMetadataValue(metadata, "status") ??
		fallback?.status ??
		(record.consumedAt ? "completed" : "pending");
	const codeVerifierRef =
		record.codeVerifierRef ??
		stringMetadataValue(metadata, "codeVerifierRef") ??
		stringMetadataValue(metadata, "code_verifier_ref");
	const metadataForFlow = safeOAuthMetadata(metadata);
	if (codeVerifierRef) {
		metadataForFlow.codeVerifierRef = codeVerifierRef;
	}
	return {
		id: flowId,
		provider: normalizeProvider(record.provider),
		state,
		status: statusValue as ConnectorOAuthFlowStatus,
		accountId: record.accountId ?? fallback?.accountId,
		authUrl: stringMetadataValue(metadata, "authUrl") ?? fallback?.authUrl,
		error: stringMetadataValue(metadata, "error") ?? fallback?.error,
		redirectUri: record.redirectUri ?? fallback?.redirectUri,
		createdAt: record.createdAt ?? fallback?.createdAt ?? now,
		updatedAt:
			typeof metadata.updatedAt === "number"
				? metadata.updatedAt
				: (fallback?.updatedAt ?? record.createdAt ?? now),
		expiresAt: record.expiresAt ?? fallback?.expiresAt,
		metadata: cloneMetadata(metadataForFlow),
	};
}

function accountKey(provider: string, accountId: string): string {
	return `${normalizeProvider(provider)}:${accountId}`;
}

function flowKey(provider: string, flowIdOrState: string): string {
	return `${normalizeProvider(provider)}:${flowIdOrState}`;
}

function ownerBindingKey(
	connector: string,
	externalId: string,
	instanceId?: string,
): string {
	return `${normalizeProvider(connector)}:${externalId}:${instanceId ?? ""}`;
}

export class ConnectorAccountManager extends Service {
	static override serviceType = CONNECTOR_ACCOUNT_SERVICE_TYPE;
	capabilityDescription =
		"Manages connector account providers, OAuth flows, and account access policy";

	private providers = new Map<string, ConnectorAccountProvider>();
	private explicitStorage?: ConnectorAccountStorage;
	private databaseStorage?: DatabaseConnectorAccountStorage;
	private databaseStorageAdapter?: ConnectorAccountDatabaseAdapter;
	private fallbackStorage?: InMemoryConnectorAccountStorage;
	private storageFacade?: ConnectorAccountStorage;
	private migration: Promise<void> = Promise.resolve();
	private warnedFallback = false;

	constructor(runtime?: IAgentRuntime, storage?: ConnectorAccountStorage) {
		super(runtime);
		this.explicitStorage = storage;
	}

	private oauthCredentialStore(): ConnectorOAuthCredentialStore | null {
		const runtime = this.runtime as IAgentRuntime | undefined;
		if (!runtime || typeof runtime.getService !== "function") return null;
		const service = runtime.getService(
			CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPE,
		) as unknown;
		return isConnectorOAuthCredentialStore(service) ? service : null;
	}

	private credentialRefStorage(): Pick<
		ConnectorAccountDatabaseAdapter,
		| "listConnectorAccountCredentialRefs"
		| "deleteConnectorAccountCredentialRefs"
	> | null {
		const runtime = this.runtime as IAgentRuntime | undefined;
		const candidates = [
			this.explicitStorage,
			runtime?.getService?.(CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE),
			(runtime as { adapter?: unknown } | undefined)?.adapter,
		];
		for (const candidate of candidates) {
			const storage =
				candidate as Partial<ConnectorAccountDatabaseAdapter> | null;
			if (
				typeof storage?.listConnectorAccountCredentialRefs === "function" &&
				typeof storage.deleteConnectorAccountCredentialRefs === "function"
			) {
				return storage as Pick<
					ConnectorAccountDatabaseAdapter,
					| "listConnectorAccountCredentialRefs"
					| "deleteConnectorAccountCredentialRefs"
				>;
			}
		}
		return null;
	}

	private async storeOAuthCodeVerifier(
		provider: string,
		flowId: string,
		codeVerifier: string | undefined,
	): Promise<string | undefined> {
		if (typeof codeVerifier !== "string" || !codeVerifier.trim()) {
			return undefined;
		}
		const store = this.oauthCredentialStore();
		if (!store) {
			throw new Error(
				"OAuth PKCE requires the durable connector_credential_store service",
			);
		}
		const runtime = this.runtime as IAgentRuntime;
		const vaultRef = oauthCodeVerifierRef(provider, flowId);
		return store.putSecret({
			vaultRef,
			agentId: String(runtime.agentId),
			provider,
			accountId: flowId,
			credentialType: "oauth.pkce",
			value: codeVerifier,
			caller: "connector-oauth-initiate",
		});
	}

	private async readOAuthCodeVerifier(
		ref: string,
	): Promise<string | undefined> {
		const store = this.oauthCredentialStore();
		if (!store) return undefined;
		try {
			const value = await store.reveal?.(ref, "connector-oauth-callback");
			return typeof value === "string" && value.trim() ? value : undefined;
		} catch (error) {
			// error-policy:J4 A missing/expired one-time verifier becomes an
			// explicit failed OAuth flow at the callback boundary below.
			logger.warn(
				`[ConnectorAccountManager] could not reveal OAuth PKCE verifier ${ref}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	private async deleteOAuthCodeVerifier(
		ref: string | undefined,
	): Promise<void> {
		if (!ref) return;
		const store = this.oauthCredentialStore();
		if (!store?.remove) return;
		try {
			await store.remove(ref);
		} catch (error) {
			// error-policy:J6 callback processing has finished; deleting its
			// consumed one-time verifier is best-effort teardown.
			logger.warn(
				`[ConnectorAccountManager] could not delete consumed OAuth PKCE verifier ${ref}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	static override async start(
		runtime: IAgentRuntime,
	): Promise<ConnectorAccountManager> {
		return getConnectorAccountManager(runtime);
	}

	async stop(): Promise<void> {}

	/**
	 * Storage is resolved lazily on every access rather than pinned at
	 * construction. The manager is typically constructed during concurrent
	 * plugin registration — often before the SQL adapter is attached to the
	 * runtime — and it is cached per-runtime for the process lifetime. A
	 * construction-time binding therefore captured the in-memory fallback
	 * forever, so connector accounts written after OAuth completion never
	 * reached the durable connector_accounts table and vanished on restart.
	 * Precedence: explicitly injected storage (constructor/setStorage) → a
	 * registered connector_account_storage service → the runtime database
	 * adapter (memoized per adapter) → one persistent in-memory fallback.
	 *
	 * The getter returns one stable facade whose every operation re-resolves
	 * the backend and, when a durable backend has appeared, first drains the
	 * boot-window in-memory fallback into it. Without that handoff an
	 * operation could straddle the transition — e.g. `createOAuthFlow` landing
	 * in the fallback and the matching `updateOAuthFlow` targeting the fresh
	 * database wrapper — silently losing the state it depends on.
	 */
	private get storage(): ConnectorAccountStorage {
		if (!this.storageFacade) {
			this.storageFacade = this.createStorageFacade();
		}
		return this.storageFacade;
	}

	private resolveBackend(): ConnectorAccountStorage {
		if (this.explicitStorage) {
			return this.explicitStorage;
		}
		const runtime = this.runtime as IAgentRuntime | undefined;
		if (runtime && typeof runtime.getService === "function") {
			const service = runtime.getService(
				CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
			);
			if (isConnectorAccountStorage(service)) {
				return service;
			}
			const adapter = (runtime as { adapter?: unknown }).adapter;
			if (isConnectorAccountDatabaseAdapter(adapter)) {
				if (this.databaseStorageAdapter !== adapter) {
					this.databaseStorage = new DatabaseConnectorAccountStorage(
						adapter,
						String(runtime.agentId),
					);
					this.databaseStorageAdapter = adapter;
				}
				return this.databaseStorage as DatabaseConnectorAccountStorage;
			}
			if (!this.warnedFallback) {
				this.warnedFallback = true;
				logger.warn(
					"[ConnectorAccountManager] no durable connector-account storage available yet; using in-memory fallback until a database adapter registers",
				);
			}
		}
		if (!this.fallbackStorage) {
			this.fallbackStorage = new InMemoryConnectorAccountStorage();
		}
		return this.fallbackStorage;
	}

	/**
	 * Resolve the backend for one storage operation, completing the
	 * fallback→durable handoff first when one is pending. Handoffs are
	 * serialized on a single promise chain so concurrent operations cannot
	 * interleave with a half-drained migration; a failed handoff rejects the
	 * awaiting operation (fail loud) and leaves the fallback state intact for
	 * the next attempt.
	 */
	private async backendForOperation(): Promise<ConnectorAccountStorage> {
		const backend = this.resolveBackend();
		if (
			this.fallbackStorage &&
			backend !== this.fallbackStorage &&
			this.fallbackStorage.hasStateForMigration()
		) {
			const attempt = this.migration.then(() =>
				this.migrateFallbackState(backend),
			);
			// error-policy:J5 the rejection is observed by `await attempt` below;
			// the chain itself must not stay poisoned for later operations.
			this.migration = attempt.catch(() => {});
			await attempt;
		}
		return backend;
	}

	private async migrateFallbackState(
		target: ConnectorAccountStorage,
	): Promise<void> {
		const fallback = this.fallbackStorage;
		if (!fallback?.hasStateForMigration()) {
			return;
		}
		const { accounts, flows, consumedPendingFlows } =
			fallback.snapshotForMigration();
		for (const account of accounts) {
			await target.upsertAccount(account);
		}
		for (const flow of flows) {
			await target.createOAuthFlow(flow);
		}
		// A flow consumed in the fallback while its completeOAuth awaits the
		// provider must stay addressable after the handoff: recreate it and
		// replay the consumption so the terminal updateOAuthFlow lands on the
		// durable backend instead of vanishing.
		for (const flow of consumedPendingFlows) {
			await target.createOAuthFlow(flow);
			await target.consumeOAuthFlow(
				flow.provider,
				flow.state,
				"fallback-migration",
			);
		}
		fallback.clearAfterMigration();
		logger.info(
			`[ConnectorAccountManager] migrated ${accounts.length} connector account(s), ${flows.length} pending OAuth flow(s), and ${consumedPendingFlows.length} in-flight consumed OAuth flow(s) from the boot-time in-memory fallback to durable storage`,
		);
	}

	private createStorageFacade(): ConnectorAccountStorage {
		const resolve = () => this.backendForOperation();
		return {
			listAccounts: async (provider) =>
				(await resolve()).listAccounts(provider),
			getAccount: async (provider, accountId) =>
				(await resolve()).getAccount(provider, accountId),
			upsertAccount: async (account) =>
				(await resolve()).upsertAccount(account),
			deleteAccount: async (provider, accountId) =>
				(await resolve()).deleteAccount(provider, accountId),
			createOAuthFlow: async (flow) => (await resolve()).createOAuthFlow(flow),
			getOAuthFlow: async (provider, flowIdOrState) =>
				(await resolve()).getOAuthFlow(provider, flowIdOrState),
			updateOAuthFlow: async (provider, flowIdOrState, patch) =>
				(await resolve()).updateOAuthFlow(provider, flowIdOrState, patch),
			consumeOAuthFlow: async (provider, state, consumedBy) =>
				(await resolve()).consumeOAuthFlow(provider, state, consumedBy),
			deleteOAuthFlow: async (provider, flowIdOrState) =>
				(await resolve()).deleteOAuthFlow(provider, flowIdOrState),
			findOwnerBinding: async (lookup) => {
				const backend = await resolve();
				return typeof backend.findOwnerBinding === "function"
					? backend.findOwnerBinding(lookup)
					: null;
			},
		};
	}

	getStorage(): ConnectorAccountStorage {
		return this.storage;
	}

	setStorage(storage: ConnectorAccountStorage): void {
		this.explicitStorage = storage;
	}

	registerProvider(
		provider: ConnectorAccountProvider,
	): ConnectorAccountProviderRegistrationResult {
		const providerId = normalizeProvider(provider.provider);
		if (!providerId) {
			throw new Error("Connector account provider requires a provider id");
		}
		const normalized: ConnectorAccountProvider = {
			...provider,
			provider: providerId,
		};
		this.providers.set(providerId, normalized);

		let messageConnectorRegistered = false;
		let messageConnectorSkipped = false;
		let postConnectorRegistered = false;
		let postConnectorSkipped = false;
		const runtime = this.runtime;

		if (runtime && normalized.messageConnector) {
			const source = normalized.messageConnector.source.trim();
			const exists = runtime
				.getMessageConnectors()
				.some((connector) => connector.source === source);
			if (exists) {
				messageConnectorSkipped = true;
			} else {
				runtime.registerMessageConnector(normalized.messageConnector);
				messageConnectorRegistered = true;
			}
		}

		if (runtime && normalized.postConnector) {
			const source = normalized.postConnector.source.trim();
			const exists = runtime
				.getPostConnectors()
				.some((connector) => connector.source === source);
			if (exists) {
				postConnectorSkipped = true;
			} else {
				runtime.registerPostConnector(normalized.postConnector);
				postConnectorRegistered = true;
			}
		}

		return {
			provider: providerId,
			messageConnectorRegistered,
			messageConnectorSkipped,
			postConnectorRegistered,
			postConnectorSkipped,
		};
	}

	unregisterProvider(provider: string): boolean {
		return this.providers.delete(normalizeProvider(provider));
	}

	getProvider(provider: string): ConnectorAccountProvider | undefined {
		return this.providers.get(normalizeProvider(provider));
	}

	listProviders(): ConnectorAccountProvider[] {
		return Array.from(this.providers.values()).sort((a, b) =>
			a.provider.localeCompare(b.provider),
		);
	}

	async listAccounts(provider: string): Promise<ConnectorAccount[]> {
		const providerId = normalizeProvider(provider);
		const registered = this.providers.get(providerId);
		const storedAccounts = await this.storage.listAccounts(providerId);
		if (registered?.listAccounts) {
			const providerAccounts = (await registered.listAccounts(this)).map(
				cloneAccount,
			);
			const merged = new Map<string, ConnectorAccount>();
			for (const account of storedAccounts) {
				merged.set(account.id, account);
			}
			for (const account of providerAccounts) {
				const stored = merged.get(account.id);
				merged.set(
					account.id,
					stored ? mergeStoredAndProviderAccount(stored, account) : account,
				);
			}
			return Array.from(merged.values());
		}
		return storedAccounts;
	}

	async getAccount(
		provider: string,
		accountId: string,
	): Promise<ConnectorAccount | null> {
		const providerId = normalizeProvider(provider);
		const stored = await this.storage.getAccount(providerId, accountId);
		if (stored) return stored;
		const registered = this.providers.get(providerId);
		if (!registered?.listAccounts) return null;
		const providerAccounts = (await registered.listAccounts(this)).map(
			cloneAccount,
		);
		const providerAccount = providerAccounts.find(
			(account) =>
				account.id === accountId ||
				account.externalId === accountId ||
				account.displayHandle === accountId,
		);
		return providerAccount ?? null;
	}

	async upsertAccount(
		provider: string,
		input: ConnectorAccount | ConnectorAccountPatch,
		accountId?: string,
	): Promise<ConnectorAccount> {
		const normalized = normalizeAccount(input, provider, accountId);
		const ownerBinding = await this.resolveOwnerBindingForAccount(normalized);
		const account = ownerBinding
			? {
					...normalized,
					ownerBindingId: normalized.ownerBindingId ?? ownerBinding.id,
					ownerIdentityId:
						normalized.ownerIdentityId ?? ownerBinding.identityId,
					displayHandle: normalized.displayHandle ?? ownerBinding.displayHandle,
				}
			: normalized;
		return this.storage.upsertAccount(account);
	}

	async createAccount(
		provider: string,
		input: ConnectorAccountPatch,
	): Promise<ConnectorAccount> {
		const providerId = normalizeProvider(provider);
		const registered = this.providers.get(providerId);
		const accountId =
			typeof (input as Partial<ConnectorAccount>).id === "string" &&
			(input as Partial<ConnectorAccount>).id?.trim()
				? (input as Partial<ConnectorAccount>).id
				: randomId(`acct_${providerId}`);
		let account: ConnectorAccount;
		if (registered?.createAccount) {
			const created = await registered.createAccount(input, this);
			account = await this.upsertAccount(providerId, created, accountId);
		} else {
			account = await this.upsertAccount(providerId, input, accountId);
		}
		await this.notifyAccountUpserted(registered, account, "create");
		return account;
	}

	async patchAccount(
		provider: string,
		accountId: string,
		patch: ConnectorAccountPatch,
	): Promise<ConnectorAccount | null> {
		const providerId = normalizeProvider(provider);
		const registered = this.providers.get(providerId);
		let account: ConnectorAccount | null;
		if (registered?.patchAccount) {
			const patched = await registered.patchAccount(accountId, patch, this);
			account = await this.upsertAccount(providerId, patched, accountId);
		} else {
			const existing = await this.storage.getAccount(providerId, accountId);
			if (!existing) return null;
			account = await this.upsertAccount(
				providerId,
				mergeAccountPatch(existing, patch),
			);
		}
		await this.notifyAccountUpserted(registered, account, "patch");
		return account;
	}

	async deleteAccount(provider: string, accountId: string): Promise<boolean> {
		const providerId = normalizeProvider(provider);
		const registered = this.providers.get(providerId);
		const account = await this.storage.getAccount(providerId, accountId);
		const durableAccountId = account?.id ?? accountId;
		const credentialRefStorage = this.credentialRefStorage();
		const credentialRefs = credentialRefStorage
			? await credentialRefStorage.listConnectorAccountCredentialRefs?.({
					accountId: durableAccountId,
				})
			: [];
		if (registered?.deleteAccount) {
			await registered.deleteAccount(durableAccountId, this);
		}
		if (credentialRefs && credentialRefs.length > 0) {
			const credentialStore = this.oauthCredentialStore();
			if (!credentialStore?.remove) {
				throw new Error(
					`Cannot delete ${providerId} account ${accountId}: its credential refs exist but no removable connector credential vault is available.`,
				);
			}
			for (const vaultRef of new Set(
				credentialRefs.map((credential) => credential.vaultRef),
			)) {
				await credentialStore.remove(vaultRef);
			}
			const deletedRefs =
				(await credentialRefStorage?.deleteConnectorAccountCredentialRefs?.({
					accountId: durableAccountId,
				})) ?? 0;
			if (deletedRefs !== credentialRefs.length) {
				throw new Error(
					`Cannot delete ${providerId} account ${accountId}: deleted ${deletedRefs} of ${credentialRefs.length} credential refs.`,
				);
			}
		}
		return this.storage.deleteAccount(providerId, accountId);
	}

	async startOAuth(
		provider: string,
		input: {
			redirectUri?: string;
			accountId?: string;
			label?: string;
			scopes?: string[];
			metadata?: Metadata;
		} = {},
	): Promise<ConnectorOAuthFlow> {
		const providerId = normalizeProvider(provider);
		const registered = this.providers.get(providerId);
		if (!registered?.startOAuth) {
			throw new Error(
				`OAuth not supported for connector provider: ${providerId}`,
			);
		}

		const now = nowMs();
		const flow: ConnectorOAuthFlow = {
			id: randomId("oauth"),
			provider: providerId,
			state: randomId("state"),
			status: "pending",
			accountId: input.accountId,
			redirectUri: input.redirectUri,
			createdAt: now,
			updatedAt: now,
			metadata: cloneMetadata(input.metadata),
		};
		await this.storage.createOAuthFlow(flow);

		let result: ConnectorOAuthStartResult;
		try {
			result = await registered.startOAuth(
				{
					provider: providerId,
					flow,
					redirectUri: input.redirectUri,
					accountId: input.accountId,
					label: input.label,
					scopes: input.scopes,
					metadata: input.metadata,
				},
				this,
			);
		} catch (err) {
			// error-policy:J2 Persist the explicit failed OAuth state before
			// preserving the provider failure.
			try {
				await this.storage.updateOAuthFlow(providerId, flow.id, {
					status: "failed",
					error: err instanceof Error ? err.message : String(err),
				});
			} catch (persistenceError) {
				// error-policy:J2 Preserve both the OAuth and state-write failures.
				throw new AggregateError(
					[err, persistenceError],
					`OAuth start and failure-state persistence failed for ${providerId}`,
				);
			}
			throw err;
		}
		let codeVerifierRef: string | undefined;
		try {
			codeVerifierRef = await this.storeOAuthCodeVerifier(
				providerId,
				flow.id,
				result.codeVerifier,
			);
		} catch (error) {
			// error-policy:J2 Persist an explicit failed flow, then preserve the
			// durable-vault write failure for the caller.
			await this.storage.updateOAuthFlow(providerId, flow.id, {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		const metadata = safeOAuthMetadata(result.metadata ?? flow.metadata);
		if (codeVerifierRef) metadata.codeVerifierRef = codeVerifierRef;
		let updated: ConnectorOAuthFlow | null;
		try {
			updated = await this.storage.updateOAuthFlow(providerId, flow.id, {
				authUrl: result.authUrl,
				expiresAt: result.expiresAt,
				metadata,
			});
		} catch (error) {
			// error-policy:J2 Remove the orphaned verifier reference, then
			// preserve the flow-state persistence failure.
			await this.deleteOAuthCodeVerifier(codeVerifierRef);
			throw error;
		}
		return updated ?? { ...flow, authUrl: result.authUrl };
	}

	async getOAuthFlow(
		provider: string,
		flowIdOrState: string,
	): Promise<ConnectorOAuthFlow | null> {
		return this.storage.getOAuthFlow(
			normalizeProvider(provider),
			flowIdOrState,
		);
	}

	async completeOAuth(
		provider: string,
		input: {
			state: string;
			code?: string;
			error?: string;
			errorDescription?: string;
			query?: Record<string, string>;
			body?: Record<string, unknown>;
		},
	): Promise<{
		flow: ConnectorOAuthFlow;
		account?: ConnectorAccount;
		redirectUrl?: string;
	}> {
		const providerId = normalizeProvider(provider);
		const flow = await this.storage.consumeOAuthFlow(
			providerId,
			input.state,
			"connector-oauth-callback",
		);
		if (!flow) {
			throw new Error("Unknown, expired, or already used OAuth flow state");
		}
		if (flow.status !== "pending") {
			throw new Error(`OAuth flow is already ${flow.status}`);
		}

		if (input.error) {
			const failed = await this.storage.updateOAuthFlow(providerId, flow.id, {
				status: "failed",
				error: input.errorDescription ?? input.error,
			});
			await this.deleteOAuthCodeVerifier(
				stringMetadataValue(flow.metadata, "codeVerifierRef"),
			);
			return { flow: failed ?? flow };
		}

		const codeVerifierRef = stringMetadataValue(
			flow.metadata,
			"codeVerifierRef",
		);
		const codeVerifier = codeVerifierRef
			? await this.readOAuthCodeVerifier(codeVerifierRef)
			: undefined;
		if (codeVerifierRef && !codeVerifier) {
			const failed = await this.storage.updateOAuthFlow(providerId, flow.id, {
				status: "failed",
				error:
					"This authorization link's one-time PKCE secret is unavailable. Start the OAuth flow again and use the fresh link.",
			});
			await this.deleteOAuthCodeVerifier(codeVerifierRef);
			return { flow: failed ?? flow };
		}
		const callbackFlow = codeVerifier ? { ...flow, codeVerifier } : flow;

		const registered = this.providers.get(providerId);
		if (!registered?.completeOAuth) {
			throw new Error(
				`OAuth callback not supported for connector provider: ${providerId}`,
			);
		}

		try {
			const result = await registered.completeOAuth(
				{
					provider: providerId,
					flow: callbackFlow,
					code: input.code,
					error: input.error,
					errorDescription: input.errorDescription,
					query: input.query ?? {},
					body: input.body,
				},
				this,
			);

			const account = result.account
				? await this.upsertAccount(providerId, result.account, flow.accountId)
				: undefined;
			if (account) {
				await this.notifyAccountUpserted(registered, account, "oauth");
			}
			const completed = await this.storage.updateOAuthFlow(
				providerId,
				flow.id,
				{
					...result.flow,
					status: result.flow?.status ?? "completed",
					accountId: account?.id ?? result.flow?.accountId ?? flow.accountId,
					metadata: result.metadata ?? result.flow?.metadata ?? flow.metadata,
				},
			);
			return {
				flow: completed ?? flow,
				account,
				redirectUrl: result.redirectUrl,
			};
		} finally {
			await this.deleteOAuthCodeVerifier(codeVerifierRef);
		}
	}

	private async notifyAccountUpserted(
		provider: ConnectorAccountProvider | undefined,
		account: ConnectorAccount,
		reason: "create" | "patch" | "oauth",
	): Promise<void> {
		if (!provider?.afterAccountUpsert) return;
		try {
			await provider.afterAccountUpsert(account, reason, this);
		} catch (error) {
			// error-policy:J4 The durable connection remains valid while its
			// optional execution adapter is explicitly reported as degraded.
			this.runtime?.reportError?.("connector-account-materialization", error, {
				provider: account.provider,
				accountId: account.id,
				reason,
			});
			logger.warn(
				{ error, provider: account.provider, accountId: account.id, reason },
				"[ConnectorAccountManager] connector account materialization failed",
			);
		}
	}

	async evaluatePolicy(
		policy: ConnectorAccountPolicy,
		context: ConnectorAccountPolicyContext = {},
	): Promise<ConnectorAccountPolicyEvaluation> {
		const providerId = normalizeProvider(policy.provider);
		if (!providerId) {
			return {
				allowed: policy.required === false,
				reason: "Connector account policy is missing provider",
				policy,
			};
		}

		const explicitAccountId =
			context.accountId ?? resolveAccountIdFromParameters(policy, context);
		if (policy.accountIdParam && context.parameters && !explicitAccountId) {
			return {
				allowed: policy.required === false,
				provider: providerId,
				reason: `Missing connector account parameter: ${policy.accountIdParam}`,
				policy,
			};
		}
		// Use the manager-level account lookups (this.getAccount / this.listAccounts)
		// rather than storage directly: those merge provider-registered accounts
		// (e.g. connectors that expose accounts via registerProvider instead of
		// persisting them), so a policy on an explicit accountId can actually find
		// it. Reading storage directly would silently miss provider accounts.
		const accounts = explicitAccountId
			? [await this.getAccount(providerId, explicitAccountId)].filter(Boolean)
			: await this.listAccounts(providerId);

		let lastFailure: string | undefined;
		for (const account of accounts) {
			if (!account) continue;
			const failure = await this.accountPolicyFailure(account, policy, context);
			if (!failure) {
				return { allowed: true, provider: providerId, account, policy };
			}
			lastFailure = failure;
		}

		const accountText = explicitAccountId
			? `account ${explicitAccountId}`
			: `a ${providerId} account`;
		return {
			allowed: policy.required === false,
			provider: providerId,
			reason:
				explicitAccountId && lastFailure
					? lastFailure
					: `No ${accountText} satisfies connector account policy`,
			policy,
		};
	}

	private async accountPolicyFailure(
		account: ConnectorAccount,
		policy: ConnectorAccountPolicy,
		context: ConnectorAccountPolicyContext,
	): Promise<string | undefined> {
		const statuses = policy.statuses ?? ["connected"];
		if (!statuses.includes(account.status)) {
			return `status ${account.status} is not allowed`;
		}
		if (
			policy.roles?.length &&
			!policy.roles
				.map((role) => normalizeConnectorAccountRole(role))
				.includes(normalizeConnectorAccountRole(account.role))
		) {
			return `role ${account.role} is not allowed`;
		}
		const expectedPurposes = context.purpose
			? [...(policy.purposes ?? []), context.purpose]
			: policy.purposes;
		if (expectedPurposes?.length) {
			const actual = new Set(account.purpose);
			if (!expectedPurposes.some((purpose) => actual.has(purpose))) {
				return `purpose ${account.purpose.join(",")} is not allowed`;
			}
		}
		if (policy.requiredCapabilities?.length) {
			const granted = new Set(account.capabilities ?? []);
			const missing = policy.requiredCapabilities.filter(
				(capability) => !granted.has(capability),
			);
			if (missing.length > 0) {
				return `required connector capabilities are missing: ${missing.join(",")}`;
			}
		}
		if (
			policy.accessGates?.length &&
			!policy.accessGates.includes(account.accessGate)
		) {
			return `access gate ${account.accessGate} is not allowed`;
		}
		if (account.accessGate === "disabled") {
			return "access gate disabled";
		}
		if (account.accessGate === "owner_binding") {
			const binding = await this.resolveOwnerBindingForAccount(account);
			if (!binding) {
				return "owner binding has not been verified";
			}
		}
		return undefined;
	}

	private async resolveOwnerBindingForAccount(
		account: ConnectorAccount,
	): Promise<ConnectorOwnerBindingRecord | null> {
		if (!account.externalId || !this.storage.findOwnerBinding) {
			return null;
		}
		const instanceId =
			typeof account.metadata?.instanceId === "string"
				? account.metadata.instanceId
				: undefined;
		return this.storage.findOwnerBinding({
			connector: account.provider,
			externalId: account.externalId,
			instanceId,
		});
	}
}

export function getConnectorAccountManager(
	runtime?: IAgentRuntime | null,
	storage?: ConnectorAccountStorage,
): ConnectorAccountManager {
	if (runtime) {
		const service = runtime.getService(CONNECTOR_ACCOUNT_SERVICE_TYPE);
		if (service instanceof ConnectorAccountManager) {
			if (storage) service.setStorage(storage);
			return service;
		}
		if (
			service &&
			"registerProvider" in service &&
			"evaluatePolicy" in service
		) {
			return service as ConnectorAccountManager;
		}

		const existing = runtimeManagers.get(runtime);
		if (existing) {
			if (storage) existing.setStorage(storage);
			return existing;
		}
		const manager = new ConnectorAccountManager(runtime, storage);
		runtimeManagers.set(runtime, manager);
		return manager;
	}

	if (!standaloneManager) {
		standaloneManager = new ConnectorAccountManager(undefined, storage);
	} else if (storage) {
		standaloneManager.setStorage(storage);
	}
	return standaloneManager;
}

export async function evaluateConnectorAccountPolicies(
	runtime: IAgentRuntime,
	action: Action,
	context: ConnectorAccountPolicyContext = {},
): Promise<ConnectorAccountPolicyEvaluation> {
	const policies = getActionConnectorAccountPolicies(action);
	if (policies.length === 0) {
		return { allowed: true };
	}

	const manager = getConnectorAccountManager(runtime);
	let lastDenied: ConnectorAccountPolicyEvaluation | undefined;
	for (const policy of policies) {
		const result = await manager.evaluatePolicy(policy, context);
		if (result.allowed) {
			return result;
		}
		lastDenied = result;
	}

	return {
		allowed: false,
		reason:
			lastDenied?.reason ??
			(policies.length === 1
				? `Connector account policy denied action ${action.name}`
				: `No connector account policy option allowed action ${action.name}`),
		policy: lastDenied?.policy ?? policies[0],
	};
}

export function getActionConnectorAccountPolicies(
	action: Action,
): ConnectorAccountPolicy[] {
	const withPolicy = action as ActionWithConnectorAccountPolicy;
	const raw = withPolicy.connectorAccountPolicy ?? withPolicy.accountPolicy;
	if (!raw) return [];
	return (Array.isArray(raw) ? raw : [raw]).map((policy) => ({
		...policy,
		provider: normalizeProvider(policy.provider),
		roles: policy.roles ? [...policy.roles] : undefined,
		purposes: policy.purposes ? [...policy.purposes] : undefined,
		accessGates: policy.accessGates ? [...policy.accessGates] : undefined,
		statuses: policy.statuses ? [...policy.statuses] : undefined,
		requiredCapabilities: policy.requiredCapabilities
			? [...policy.requiredCapabilities]
			: undefined,
	}));
}

function resolveAccountIdFromParameters(
	policy: ConnectorAccountPolicy,
	context: ConnectorAccountPolicyContext,
): string | undefined {
	if (!policy.accountIdParam || !context.parameters) {
		return undefined;
	}
	const value = context.parameters[policy.accountIdParam];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getUntrustedMessageMetadataAccountId(
	message: Memory | undefined,
): string | undefined {
	const metadata = message?.content?.metadata as MemoryMetadata | undefined;
	const value =
		metadata && typeof metadata === "object"
			? (metadata as Record<string, unknown>).accountId
			: undefined;
	return typeof value === "string" ? value : undefined;
}
