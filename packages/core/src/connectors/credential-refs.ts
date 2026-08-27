/**
 * Persists connector credentials through the runtime's durable vault and
 * account-reference boundaries. Provider plugins supply credential records;
 * this module owns writer discovery, reference naming, ordered fallback, and
 * fail-closed completion semantics.
 */

import { ElizaError } from "../errors.js";
import type { IAgentRuntime } from "../types/runtime.js";
import {
	CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
	type ConnectorAccountManager,
} from "./account-manager.js";

export type ConnectorCredentialJsonValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| ConnectorCredentialJsonValue[]
	| { readonly [key: string]: ConnectorCredentialJsonValue };

export type ConnectorCredentialJsonRecord = Record<
	string,
	ConnectorCredentialJsonValue
>;

export const CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES = [
	"connector_credential_store",
	"CONNECTOR_CREDENTIAL_STORE",
	"connectorCredentialStore",
	"credential_store",
] as const;

export const CONNECTOR_VAULT_SERVICE_TYPES = ["vault", "VAULT"] as const;

export interface ConnectorCredentialRefMetadata
	extends ConnectorCredentialJsonRecord {
	credentialType: string;
	vaultRef: string;
	expiresAt?: number;
	metadata?: ConnectorCredentialJsonRecord;
}

export interface ConnectorCredentialInput {
	credentialType: string;
	value: string;
	expiresAt?: number;
	metadata?: ConnectorCredentialJsonRecord;
}

export interface ConnectorCredentialPersistResult {
	refs: ConnectorCredentialRefMetadata[];
	vaultAvailable: boolean;
	storageAvailable: boolean;
}

export interface PersistConnectorCredentialRefsParams {
	runtime: IAgentRuntime;
	manager?: ConnectorAccountManager;
	provider: string;
	accountIdForRef: string;
	storageAccountId?: string;
	credentials: ConnectorCredentialInput[];
	caller: string;
}

export interface WriteConnectorCredentialSecretParams {
	runtime: IAgentRuntime;
	provider: string;
	accountId: string;
	caller: string;
	credential: ConnectorCredentialInput;
	vaultRef: string;
}

export interface WriteConnectorCredentialRefMetadataParams {
	runtime: IAgentRuntime;
	manager?: ConnectorAccountManager;
	storageAccountId: string;
	refs: ConnectorCredentialRefMetadata[];
}

type VaultWriter = {
	name: string;
	write: (
		vaultRef: string,
		credential: ConnectorCredentialInput,
	) => Promise<string>;
	remove: (vaultRef: string) => Promise<void>;
};

type CredentialRefWriter = {
	name: string;
	write: (ref: ConnectorCredentialRefMetadata) => Promise<void>;
};

export async function persistConnectorCredentialRefs(
	params: PersistConnectorCredentialRefsParams,
): Promise<ConnectorCredentialPersistResult> {
	const vaultWriters = resolveVaultWriters(params.runtime, {
		provider: params.provider,
		accountId: params.accountIdForRef,
		caller: params.caller,
	});
	if (vaultWriters.length === 0) {
		throw new ElizaError(
			`No durable connector credential store or vault writer is available for ${params.provider} account ${params.accountIdForRef}. Refusing to mark OAuth account connected without persisted credentials.`,
			{
				code: "CONNECTOR_CREDENTIAL_VAULT_UNAVAILABLE",
				context: {
					provider: params.provider,
					accountId: params.accountIdForRef,
				},
			},
		);
	}
	if (!params.storageAccountId) {
		throw new ElizaError(
			`No durable connector account id is available for ${params.provider} account ${params.accountIdForRef}. Refusing to mark OAuth account connected without persisted credential refs.`,
			{
				code: "CONNECTOR_ACCOUNT_ID_REQUIRED",
				context: {
					provider: params.provider,
					accountId: params.accountIdForRef,
				},
			},
		);
	}

	const storageWriters = resolveCredentialRefWriters(
		params.runtime,
		params.manager,
		params.storageAccountId,
	);
	if (storageWriters.length === 0) {
		throw new ElizaError(
			`No durable connector credential ref writer is available for ${params.provider} account ${params.storageAccountId}. Refusing to mark OAuth account connected without persisted credential refs.`,
			{
				code: "CONNECTOR_CREDENTIAL_REF_STORAGE_UNAVAILABLE",
				context: {
					provider: params.provider,
					accountId: params.storageAccountId,
				},
			},
		);
	}

	const refs: ConnectorCredentialRefMetadata[] = [];
	const committedVaultWrites: Array<{ writer: VaultWriter; vaultRef: string }> =
		[];
	try {
		for (const credential of params.credentials) {
			const plannedRef = buildConnectorCredentialVaultRef({
				agentId: nonEmptyString(params.runtime.agentId) ?? "agent",
				provider: params.provider,
				accountId: params.accountIdForRef,
				credentialType: credential.credentialType,
			});
			const committed = await writeWithFirstAvailableVault(
				vaultWriters,
				plannedRef,
				credential,
			);
			committedVaultWrites.push(committed);
			refs.push({
				credentialType: credential.credentialType,
				vaultRef: committed.vaultRef,
				...(credential.expiresAt !== undefined
					? { expiresAt: credential.expiresAt }
					: {}),
				...(credential.metadata ? { metadata: credential.metadata } : {}),
			});
		}

		if (refs.length > 0) {
			await writeRefsToStorage(storageWriters, refs);
		}
	} catch (cause) {
		const rollbackErrors: unknown[] = [];
		for (const committed of committedVaultWrites.reverse()) {
			try {
				// error-policy:J6 A credential-ref commit failure must remove every
				// secret written by this attempt before the failure is propagated.
				await committed.writer.remove(committed.vaultRef);
			} catch (rollbackCause) {
				// error-policy:J2 Preserve cleanup failures alongside the primary
				// writer failure; callers must know the local rollback was incomplete.
				rollbackErrors.push(rollbackCause);
			}
		}
		if (rollbackErrors.length === 0) throw cause;
		throw new ElizaError(
			"Connector credential persistence rollback was incomplete.",
			{
				code: "CONNECTOR_CREDENTIAL_ROLLBACK_FAILED",
				cause: new AggregateError(
					[cause, ...rollbackErrors],
					"Connector credential persistence and rollback failed",
				),
				context: {
					provider: params.provider,
					rollbackFailureCount: rollbackErrors.length,
				},
				severity: "fatal",
			},
		);
	}

	return {
		refs,
		vaultAvailable: true,
		storageAvailable: true,
	};
}

/** Rewrites secret material behind an existing durable connector vault ref. */
export async function writeConnectorCredentialSecret(
	params: WriteConnectorCredentialSecretParams,
): Promise<string> {
	const writers = resolveVaultWriters(params.runtime, {
		provider: params.provider,
		accountId: params.accountId,
		caller: params.caller,
	});
	if (writers.length === 0) {
		throw new ElizaError(
			`No durable connector credential store or vault writer is available for ${params.provider} account ${params.accountId}. Refusing to update unpersisted credentials.`,
			{
				code: "CONNECTOR_CREDENTIAL_VAULT_UNAVAILABLE",
				context: { provider: params.provider, accountId: params.accountId },
			},
		);
	}
	const committed = await writeWithFirstAvailableVault(
		writers,
		params.vaultRef,
		params.credential,
	);
	return committed.vaultRef;
}

/** Writes an already-vaulted connector reference set through ordered fallback. */
export async function writeConnectorCredentialRefMetadata(
	params: WriteConnectorCredentialRefMetadataParams,
): Promise<void> {
	const writers = resolveCredentialRefWriters(
		params.runtime,
		params.manager,
		params.storageAccountId,
	);
	if (writers.length === 0) {
		throw new ElizaError(
			`No durable connector credential ref writer is available for account ${params.storageAccountId}.`,
			{
				code: "CONNECTOR_CREDENTIAL_REF_STORAGE_UNAVAILABLE",
				context: { accountId: params.storageAccountId },
			},
		);
	}
	await writeRefsToStorage(writers, params.refs);
}

export function buildConnectorCredentialVaultRef(params: {
	agentId: string;
	provider: string;
	accountId: string;
	credentialType: string;
}): string {
	return [
		"connector",
		normalizeVaultSegment(params.agentId),
		normalizeVaultSegment(params.provider),
		normalizeVaultSegment(params.accountId),
		normalizeVaultSegment(params.credentialType),
	].join(".");
}

function resolveVaultWriters(
	runtime: IAgentRuntime,
	context: { provider: string; accountId: string; caller: string },
): VaultWriter[] {
	const writers: VaultWriter[] = [];
	const credentialStore = getFirstService(
		runtime,
		CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES,
	) as {
		putSecret?: (params: {
			vaultRef?: string;
			agentId: string;
			provider: string;
			accountId: string;
			credentialType: string;
			value: string;
			caller?: string;
		}) => Promise<string> | string;
		remove?: (vaultRef: string) => Promise<void> | void;
	} | null;
	if (
		typeof credentialStore?.putSecret === "function" &&
		typeof credentialStore.remove === "function"
	) {
		writers.push({
			name: "connector_credential_store",
			write: async (vaultRef, credential) =>
				credentialStore.putSecret?.({
					vaultRef,
					agentId: nonEmptyString(runtime.agentId) ?? "agent",
					provider: context.provider,
					accountId: context.accountId,
					credentialType: credential.credentialType,
					value: credential.value,
					caller: context.caller,
				}) ?? vaultRef,
			remove: async (vaultRef) => {
				await credentialStore.remove?.(vaultRef);
			},
		});
	}

	const vault = getFirstService(runtime, CONNECTOR_VAULT_SERVICE_TYPES) as {
		set?: (
			key: string,
			value: string,
			options?: { sensitive?: boolean; caller?: string },
		) => Promise<void> | void;
		remove?: (key: string) => Promise<void> | void;
	} | null;
	if (typeof vault?.set === "function" && typeof vault.remove === "function") {
		writers.push({
			name: "vault",
			write: async (vaultRef, credential) => {
				await vault.set?.(vaultRef, credential.value, {
					sensitive: true,
					caller: context.caller,
				});
				return vaultRef;
			},
			remove: async (vaultRef) => {
				await vault.remove?.(vaultRef);
			},
		});
	}
	return writers;
}

function resolveCredentialRefWriters(
	runtime: IAgentRuntime,
	manager: ConnectorAccountManager | undefined,
	accountId: string,
): CredentialRefWriter[] {
	const candidates = [
		manager?.getStorage?.(),
		getService(runtime, CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE),
		(runtime as { adapter?: unknown }).adapter,
	].filter(Boolean);
	const seen = new Set<unknown>();
	const writers: CredentialRefWriter[] = [];

	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		const writer = candidate as {
			setConnectorAccountCredentialRef?: (
				params: ConnectorCredentialRefMetadata & { accountId: string },
			) => Promise<unknown> | unknown;
			setCredentialRef?: (
				params: ConnectorCredentialRefMetadata & { accountId: string },
			) => Promise<unknown> | unknown;
		};
		const write =
			typeof writer.setConnectorAccountCredentialRef === "function"
				? writer.setConnectorAccountCredentialRef.bind(writer)
				: typeof writer.setCredentialRef === "function"
					? writer.setCredentialRef.bind(writer)
					: null;
		if (!write) continue;
		writers.push({
			name:
				typeof writer.setConnectorAccountCredentialRef === "function"
					? "setConnectorAccountCredentialRef"
					: "setCredentialRef",
			write: async (ref) => {
				await write({ accountId, ...ref });
			},
		});
	}
	return writers;
}

async function writeWithFirstAvailableVault(
	writers: VaultWriter[],
	plannedRef: string,
	credential: ConnectorCredentialInput,
): Promise<{ writer: VaultWriter; vaultRef: string }> {
	const errors: Error[] = [];
	for (const writer of writers) {
		try {
			return { writer, vaultRef: await writer.write(plannedRef, credential) };
		} catch (error) {
			// error-policy:J2 Preserve each writer cause before raising one boundary error.
			errors.push(
				new Error(
					`${writer.name}: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				),
			);
		}
	}
	throw new ElizaError(
		`Failed to persist connector credential ref ${plannedRef}: ${errors.map((error) => error.message).join("; ")}`,
		{
			code: "CONNECTOR_CREDENTIAL_SECRET_WRITE_FAILED",
			context: { vaultRef: plannedRef },
			cause: new AggregateError(errors),
		},
	);
}

async function writeRefsToStorage(
	writers: CredentialRefWriter[],
	refs: ConnectorCredentialRefMetadata[],
): Promise<void> {
	const errors: Error[] = [];
	for (const writer of writers) {
		try {
			for (const ref of refs) await writer.write(ref);
			return;
		} catch (error) {
			// error-policy:J2 Preserve each writer cause before raising one boundary error.
			errors.push(
				new Error(
					`${writer.name}: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				),
			);
		}
	}
	throw new ElizaError(
		`Failed to persist connector credential refs: ${errors.map((error) => error.message).join("; ")}`,
		{
			code: "CONNECTOR_CREDENTIAL_REF_WRITE_FAILED",
			context: { credentialTypes: refs.map((ref) => ref.credentialType) },
			cause: new AggregateError(errors),
		},
	);
}

function normalizeVaultSegment(value: string): string {
	const slug = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_");
	const normalized = slug.replace(/^_+|_+$/g, "");
	return (normalized || "unknown").slice(0, 64);
}

function getFirstService(
	runtime: IAgentRuntime,
	serviceTypes: readonly string[],
): unknown {
	for (const serviceType of serviceTypes) {
		const service = getService(runtime, serviceType);
		if (service) return service;
	}
	return null;
}

function getService(runtime: IAgentRuntime, serviceType: string): unknown {
	try {
		return runtime.getService?.(serviceType) ?? null;
	} catch {
		// error-policy:J3 Unknown service names are an explicit unavailable probe.
		return null;
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
