/**
 * Defines one production-target contract shared by realization, conformance,
 * restart, authorization, cleanup, stress, and evidence lanes. Factories bind
 * native locators and actors once; callers can probe access classes but cannot
 * substitute another object or principal identifier.
 */

import { createHash } from "node:crypto";
import type { ReadView } from "../types/content";
import {
	PROGRESSIVE_CONTENT_DELIVERY_CONTRACT,
	type ProgressiveConformanceObject,
	type ProgressiveConformancePage,
	type ProgressiveContentConformanceAdapter,
	type ProgressiveContentConformanceReport,
	type ProgressiveContentPerformanceCeilings,
	runProgressiveContentConformance,
} from "./progressive-content-conformance";

export type { ProgressiveContentConformanceReport } from "./progressive-content-conformance";

export const PROGRESSIVE_CONTENT_TARGET_FACTORY_SCHEMA_VERSION =
	"elizaos.progressive-content.target-factory.v1" as const;
export const PROGRESSIVE_CONTENT_TARGET_RECEIPT_SCHEMA_VERSION =
	"elizaos.progressive-content.target-receipt.v1" as const;
export const PROGRESSIVE_CONTENT_TARGET_FAMILIES = [
	"file",
	"document",
	"memory",
	"email",
	"attachment",
	"tool-output",
] as const;

export type ProgressiveContentTargetFamily =
	(typeof PROGRESSIVE_CONTENT_TARGET_FAMILIES)[number];
export type ProgressiveContentAccessProbe =
	| "authorized"
	| "unauthorized"
	| "isolated";
export type ProgressiveContentAuthoritativeStore =
	| "filesystem"
	| "content-addressed-media"
	| "document-store"
	| "message-store"
	| "memory-store";

export interface ProgressiveContentBoundedSource {
	readonly byteLength: number;
	read(offset: number, maxBytes?: number): Promise<Uint8Array>;
}

export interface ProgressiveContentTargetObject {
	readonly id: string;
	readonly family: ProgressiveContentTargetFamily;
	readonly byteLength: number;
	readonly sourceSha256: string;
	readonly sourceRevision: string;
	readonly format: string;
	readonly authorizationScope: string;
	readonly canaries: ProgressiveConformanceObject["canaries"];
}

export interface ProgressiveContentTargetRealization {
	readonly reference: ReadView["reference"];
	readonly sourceRevision: string;
	readonly authorizationMode: "principal" | "capability";
	readonly restartScope: "resolver" | "process";
	readonly authorizationScopeDigest: string;
	readonly cleanupIdentity: string;
	readonly resolverBindingSha256: string;
}

export interface ProgressiveContentTargetSnapshot {
	readonly resolverGeneration: string;
	readonly present: boolean;
	readonly ownedBytes: number;
	readonly databaseRows: number;
	readonly temporaryArtifacts: number;
	readonly walBytes: number;
}

export interface ProgressiveContentTarget {
	readonly family: ProgressiveContentTargetFamily;
	readonly object: ProgressiveConformanceObject;
	readonly realization: ProgressiveContentTargetRealization;
	read(input: {
		readonly access: ProgressiveContentAccessProbe;
		readonly offset: number;
		readonly limit: number;
		readonly expectedRevision?: string;
	}): Promise<ProgressiveConformancePage>;
	restart(): Promise<void>;
	inspect(): Promise<ProgressiveContentTargetSnapshot>;
	cleanup(): Promise<void>;
}

export interface ProgressiveContentTargetFactory {
	readonly schemaVersion: typeof PROGRESSIVE_CONTENT_TARGET_FACTORY_SCHEMA_VERSION;
	readonly family: ProgressiveContentTargetFamily;
	readonly adapterId: string;
	readonly authoritativeStore: ProgressiveContentAuthoritativeStore;
	readonly productionMethod: string;
	readonly binaryPolicy: "native-bytes" | "typed-rejection";
	create(input: {
		readonly object: ProgressiveContentTargetObject;
		readonly source: ProgressiveContentBoundedSource;
	}): Promise<ProgressiveContentTarget>;
}

export interface ProgressiveContentTargetReceipt {
	readonly schemaVersion: typeof PROGRESSIVE_CONTENT_TARGET_RECEIPT_SCHEMA_VERSION;
	readonly targetBindingSha256: string;
	readonly phase:
		| "realized"
		| "restart"
		| "authorization"
		| "isolation"
		| "cleanup";
	readonly restartScope?: ProgressiveContentTargetRealization["restartScope"];
	readonly before: ProgressiveContentTargetSnapshot;
	readonly after: ProgressiveContentTargetSnapshot;
	readonly probe: {
		readonly access: ProgressiveContentAccessProbe;
		readonly offset: number;
		readonly limit: number;
		readonly sliceSha256?: string;
		readonly errorCode?: string;
	};
	readonly status: "passed" | "failed";
}

export interface ProgressiveContentTargetConformanceResult {
	readonly report: ProgressiveContentConformanceReport;
	readonly receipts: readonly ProgressiveContentTargetReceipt[];
}

/** Map the corpus family name to the single public content-reference kind. */
export function progressiveContentReferenceKind(
	family: ProgressiveContentTargetFamily,
): ReadView["reference"]["kind"] {
	return family === "tool-output" ? "tool-result" : family;
}

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const value = (error as { code?: unknown }).code;
	return typeof value === "string" ? value : undefined;
}

function validateSnapshot(
	snapshot: ProgressiveContentTargetSnapshot,
): ProgressiveContentTargetSnapshot {
	if (!snapshot.resolverGeneration || typeof snapshot.present !== "boolean") {
		throw new TypeError("target snapshot identity is invalid");
	}
	for (const field of [
		"ownedBytes",
		"databaseRows",
		"temporaryArtifacts",
		"walBytes",
	] as const) {
		if (!Number.isSafeInteger(snapshot[field]) || snapshot[field] < 0) {
			throw new TypeError(`target snapshot ${field} is invalid`);
		}
	}
	return snapshot;
}

function targetBindingSha256(input: {
	manifestSha256: string;
	target: ProgressiveContentTarget;
	adapterId: string;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				manifestSha256: input.manifestSha256,
				objectId: input.target.object.id,
				family: input.target.family,
				adapterId: input.adapterId,
				sourceSha256: input.target.object.sourceSha256,
				sourceRevision: input.target.realization.sourceRevision,
				nativeRevision: input.target.object.revision,
				authorizationMode: input.target.realization.authorizationMode,
				authorizationScopeDigest:
					input.target.realization.authorizationScopeDigest,
				cleanupIdentity: input.target.realization.cleanupIdentity,
				resolverBindingSha256: input.target.realization.resolverBindingSha256,
			}),
		)
		.digest("hex");
}

/**
 * Run the existing page oracle through a target-bound adapter and derive
 * lifecycle receipts from observations rather than producer-authored booleans.
 */
export async function runProgressiveContentTargetConformance(input: {
	readonly manifestSha256: string;
	readonly adapterId: string;
	readonly target: ProgressiveContentTarget;
	readonly pageBytes?: number;
	readonly performanceCeilings?: Partial<ProgressiveContentPerformanceCeilings>;
}): Promise<ProgressiveContentTargetConformanceResult> {
	if (!/^[0-9a-f]{64}$/u.test(input.manifestSha256)) {
		throw new TypeError("manifestSha256 must be a lowercase SHA-256 digest");
	}
	if (
		input.target.object.family !==
			progressiveContentReferenceKind(input.target.family) ||
		input.target.realization.reference.kind !== input.target.object.family
	) {
		throw new TypeError("target family and native reference kind differ");
	}
	if (
		input.target.realization.reference.revision !== input.target.object.revision
	) {
		throw new TypeError("target native revision differs from its reference");
	}
	if (
		!/^[0-9a-f]{64}$/u.test(
			input.target.realization.authorizationScopeDigest,
		) ||
		!input.target.realization.sourceRevision ||
		!input.target.realization.reference.ref ||
		!input.target.realization.cleanupIdentity ||
		!/^[0-9a-f]{64}$/u.test(input.target.realization.resolverBindingSha256)
	) {
		throw new TypeError("target realization binding is invalid");
	}
	const binding = targetBindingSha256(input);
	const receipts: ProgressiveContentTargetReceipt[] = [];
	const initial = validateSnapshot(await input.target.inspect());
	const receipt = async (
		phase: "authorization" | "isolation",
		access: ProgressiveContentAccessProbe,
		operation: () => Promise<ProgressiveConformancePage | undefined>,
		expectedCodes: readonly string[] = [],
	): Promise<void> => {
		const before = validateSnapshot(await input.target.inspect());
		let page: ProgressiveConformancePage | undefined;
		let code: string | undefined;
		try {
			page = await operation();
		} catch (error) {
			code = errorCode(error);
		}
		const after = validateSnapshot(await input.target.inspect());
		const status = code !== undefined && expectedCodes.includes(code);
		receipts.push({
			schemaVersion: PROGRESSIVE_CONTENT_TARGET_RECEIPT_SCHEMA_VERSION,
			targetBindingSha256: binding,
			phase,
			before,
			after,
			probe: {
				access,
				offset: 0,
				limit: 1,
				...(page ? { sliceSha256: page.view.slice.sliceSha256 } : {}),
				...(code ? { errorCode: code } : {}),
			},
			status: status ? "passed" : "failed",
		});
	};

	receipts.push({
		schemaVersion: PROGRESSIVE_CONTENT_TARGET_RECEIPT_SCHEMA_VERSION,
		targetBindingSha256: binding,
		phase: "realized",
		restartScope: input.target.realization.restartScope,
		before: initial,
		after: initial,
		probe: { access: "authorized", offset: 0, limit: 1 },
		status: initial.present ? "passed" : "failed",
	});
	await receipt(
		"authorization",
		"unauthorized",
		() => input.target.read({ access: "unauthorized", offset: 0, limit: 1 }),
		["CONTENT_ACCESS_DENIED", "unauthorized", "forbidden"],
	);
	await receipt(
		"isolation",
		"isolated",
		() => input.target.read({ access: "isolated", offset: 0, limit: 1 }),
		["CONTENT_NOT_FOUND", "not_found", "FILE_NOT_FOUND", "ENOENT"],
	);

	const adapter: ProgressiveContentConformanceAdapter = {
		adapterId: input.adapterId,
		deliveryContract: PROGRESSIVE_CONTENT_DELIVERY_CONTRACT,
		read: ({ authorizationScope, offset, limit, expectedRevision }) =>
			input.target.read({
				access:
					authorizationScope === input.target.object.authorizationScope
						? "authorized"
						: "unauthorized",
				offset,
				limit,
				...(expectedRevision ? { expectedRevision } : {}),
			}),
		async restart() {
			const before = validateSnapshot(await input.target.inspect());
			let code: string | undefined;
			try {
				await input.target.restart();
			} catch (error) {
				code = errorCode(error) ?? "untyped";
			}
			const after = validateSnapshot(await input.target.inspect());
			const passed =
				!code &&
				after.present &&
				after.resolverGeneration !== before.resolverGeneration;
			receipts.push({
				schemaVersion: PROGRESSIVE_CONTENT_TARGET_RECEIPT_SCHEMA_VERSION,
				targetBindingSha256: binding,
				phase: "restart",
				restartScope: input.target.realization.restartScope,
				before,
				after,
				probe: {
					access: "authorized",
					offset: 0,
					limit: 1,
					...(code ? { errorCode: code } : {}),
				},
				status: passed ? "passed" : "failed",
			});
			if (!passed)
				throw new Error("target restart did not replace its resolver");
		},
		async cleanup() {
			const before = validateSnapshot(await input.target.inspect());
			try {
				await input.target.cleanup();
			} catch (error) {
				const after = validateSnapshot(await input.target.inspect());
				receipts.push({
					schemaVersion: PROGRESSIVE_CONTENT_TARGET_RECEIPT_SCHEMA_VERSION,
					targetBindingSha256: binding,
					phase: "cleanup",
					before,
					after,
					probe: {
						access: "authorized",
						offset: 0,
						limit: 1,
						errorCode: errorCode(error) ?? "untyped",
					},
					status: "failed",
				});
				throw error;
			}
			const after = validateSnapshot(await input.target.inspect());
			receipts.push({
				schemaVersion: PROGRESSIVE_CONTENT_TARGET_RECEIPT_SCHEMA_VERSION,
				targetBindingSha256: binding,
				phase: "cleanup",
				before,
				after,
				probe: { access: "authorized", offset: 0, limit: 1 },
				status: !after.present ? "passed" : "failed",
			});
		},
		async measureResources() {
			const snapshot = validateSnapshot(await input.target.inspect());
			return { databaseBytes: snapshot.ownedBytes };
		},
	};
	let report = await runProgressiveContentConformance({
		adapter,
		object: input.target.object,
		...(input.pageBytes ? { pageBytes: input.pageBytes } : {}),
		...(input.performanceCeilings
			? { performanceCeilings: input.performanceCeilings }
			: {}),
	});
	const receiptFailures = receipts
		.filter(({ status }) => status === "failed")
		.map(({ phase }) => ({
			vector: `target-${phase}`,
			message: `${phase} receipt failed`,
		}));
	if (receiptFailures.length > 0) {
		report = {
			...report,
			status: "failed",
			failures: [...report.failures, ...receiptFailures],
		};
	}
	return { report, receipts };
}
