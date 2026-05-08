import type { Action, ActionParameters } from "../types/components";
import type { Memory, MemoryMetadata } from "../types/memory";
import type { Metadata } from "../types/primitives";
import type {
	IAgentRuntime,
	MessageConnectorRegistration,
	PostConnectorRegistration,
} from "../types/runtime";
import { Service } from "../types/service";

export const CONNECTOR_ACCOUNT_SERVICE_TYPE = "connector_account";
export const CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE =
	"connector_account_storage";

export type ConnectorAccountRole = "OWNER" | "AGENT" | "TEAM" | (string & {});

export type ConnectorAccountPurpose =
	| "messaging"
	| "posting"
	| "reading"
	| "admin"
	| "automation"
	| (string & {});

export type ConnectorAccountAccessGate =
	| "open"
	| "pairing"
	| "owner_binding"
	| "manual_approval"
	| "disabled"
	| (string & {});

export type ConnectorAccountStatus =
	| "connected"
	| "pending"
	| "disabled"
	| "revoked"
	| "error";

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

export interface ConnectorAccountPolicy {
	provider: string;
	roles?: ConnectorAccountRole[];
	purposes?: ConnectorAccountPurpose[];
	accessGates?: ConnectorAccountAccessGate[];
	statuses?: ConnectorAccountStatus[];
	accountIdParam?: string;
	required?: boolean;
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

function nowMs(): number {
	return Date.now();
}

function randomId(prefix: string): string {
	const random =
		typeof globalThis.crypto?.randomUUID === "function"
			? globalThis.crypto.randomUUID()
			: Math.random().toString(36).slice(2);
	return `${prefix}_${random}`;
}

function normalizeProvider(provider: string): string {
	return provider.trim().toLowerCase();
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

function cloneAccount(account: ConnectorAccount): ConnectorAccount {
	return {
		...account,
		purpose: [...account.purpose],
		metadata: cloneMetadata(account.metadata),
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
	const full = input as ConnectorAccount;
	const id = (full.id ?? accountId ?? randomId("acct")).trim();
	if (!id) {
		throw new Error("Connector account requires an id");
	}
	return {
		id,
		provider: normalizeProvider(full.provider ?? provider),
		label: typeof full.label === "string" ? full.label : undefined,
		role: normalizeConnectorAccountRole(full.role),
		purpose: normalizeStringArray(full.purpose ?? "messaging"),
		accessGate: full.accessGate ?? "open",
		status: full.status ?? "connected",
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
 * In-memory fallback for tests and for hosts that have not yet installed the
 * durable connector-account storage service. TODO(storage): replace in
 * production hosts with a ConnectorAccountStorage backed by Worker B's adapter.
 */
export class InMemoryConnectorAccountStorage
	implements ConnectorAccountStorage
{
	private accounts = new Map<string, ConnectorAccount>();
	private flows = new Map<string, ConnectorOAuthFlow>();
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

	async deleteOAuthFlow(
		provider: string,
		flowIdOrState: string,
	): Promise<boolean> {
		const existing = this.flows.get(flowKey(provider, flowIdOrState));
		if (!existing) return false;
		this.flows.delete(flowKey(existing.provider, existing.id));
		this.flows.delete(flowKey(existing.provider, existing.state));
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

function resolveStorage(runtime?: IAgentRuntime): ConnectorAccountStorage {
	if (runtime && typeof runtime.getService === "function") {
		try {
			const service = runtime.getService(
				CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
			);
			if (isConnectorAccountStorage(service)) {
				return service;
			}
		} catch {
			// Fall through to in-memory fallback.
		}
	}
	return new InMemoryConnectorAccountStorage();
}

export class ConnectorAccountManager extends Service {
	static override serviceType = CONNECTOR_ACCOUNT_SERVICE_TYPE;
	capabilityDescription =
		"Manages connector account providers, OAuth flows, and account access policy";

	private providers = new Map<string, ConnectorAccountProvider>();
	private storage: ConnectorAccountStorage;

	constructor(runtime?: IAgentRuntime, storage?: ConnectorAccountStorage) {
		super(runtime);
		this.storage = storage ?? resolveStorage(runtime);
	}

	static override async start(
		runtime: IAgentRuntime,
	): Promise<ConnectorAccountManager> {
		return getConnectorAccountManager(runtime);
	}

	async stop(): Promise<void> {}

	getStorage(): ConnectorAccountStorage {
		return this.storage;
	}

	setStorage(storage: ConnectorAccountStorage): void {
		this.storage = storage;
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
		if (registered?.listAccounts) {
			return (await registered.listAccounts(this)).map(cloneAccount);
		}
		return this.storage.listAccounts(providerId);
	}

	async getAccount(
		provider: string,
		accountId: string,
	): Promise<ConnectorAccount | null> {
		return this.storage.getAccount(normalizeProvider(provider), accountId);
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
		if (registered?.createAccount) {
			const created = await registered.createAccount(input, this);
			return this.upsertAccount(providerId, created);
		}
		return this.upsertAccount(providerId, input);
	}

	async patchAccount(
		provider: string,
		accountId: string,
		patch: ConnectorAccountPatch,
	): Promise<ConnectorAccount | null> {
		const providerId = normalizeProvider(provider);
		const registered = this.providers.get(providerId);
		if (registered?.patchAccount) {
			const patched = await registered.patchAccount(accountId, patch, this);
			return this.upsertAccount(providerId, patched, accountId);
		}
		const existing = await this.storage.getAccount(providerId, accountId);
		if (!existing) return null;
		return this.upsertAccount(providerId, mergeAccountPatch(existing, patch));
	}

	async deleteAccount(provider: string, accountId: string): Promise<boolean> {
		const providerId = normalizeProvider(provider);
		const registered = this.providers.get(providerId);
		if (registered?.deleteAccount) {
			await registered.deleteAccount(accountId, this);
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
			await this.storage.updateOAuthFlow(providerId, flow.id, {
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
		const updated = await this.storage.updateOAuthFlow(providerId, flow.id, {
			authUrl: result.authUrl,
			expiresAt: result.expiresAt,
			codeVerifier: result.codeVerifier,
			metadata: result.metadata ?? flow.metadata,
		});
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
		const flow = await this.storage.getOAuthFlow(providerId, input.state);
		if (!flow) {
			throw new Error("Unknown OAuth flow state");
		}
		if (flow.status !== "pending") {
			throw new Error(`OAuth flow is already ${flow.status}`);
		}

		if (input.error) {
			const failed = await this.storage.updateOAuthFlow(providerId, flow.id, {
				status: "failed",
				error: input.errorDescription ?? input.error,
			});
			return { flow: failed ?? flow };
		}

		const registered = this.providers.get(providerId);
		if (!registered?.completeOAuth) {
			throw new Error(
				`OAuth callback not supported for connector provider: ${providerId}`,
			);
		}

		const result = await registered.completeOAuth(
			{
				provider: providerId,
				flow,
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
		const completed = await this.storage.updateOAuthFlow(providerId, flow.id, {
			...result.flow,
			status: result.flow?.status ?? "completed",
			accountId: account?.id ?? result.flow?.accountId ?? flow.accountId,
			metadata: result.metadata ?? result.flow?.metadata ?? flow.metadata,
		});
		return {
			flow: completed ?? flow,
			account,
			redirectUrl: result.redirectUrl,
		};
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
		const accounts = explicitAccountId
			? [await this.storage.getAccount(providerId, explicitAccountId)].filter(
					Boolean,
				)
			: await this.listAccounts(providerId);

		for (const account of accounts) {
			if (!account) continue;
			const failure = await this.accountPolicyFailure(account, policy, context);
			if (!failure) {
				return { allowed: true, provider: providerId, account, policy };
			}
		}

		const accountText = explicitAccountId
			? `account ${explicitAccountId}`
			: `a ${providerId} account`;
		return {
			allowed: policy.required === false,
			provider: providerId,
			reason: `No ${accountText} satisfies connector account policy`,
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
			if (!binding && !account.ownerBindingId && !account.ownerIdentityId) {
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
		try {
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
		} catch {
			// Fall through to per-runtime manager.
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
