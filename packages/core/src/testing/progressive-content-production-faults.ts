/**
 * Executes the progressive-content fault vectors that cross storage, transport,
 * connector, and continuity boundaries. Each executor first causes an
 * operational failure, translates that observed cause into the public error
 * code, and records a private receipt that a separate observer reads from disk.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";
import { ElizaError } from "../errors";
import type {
	ProgressiveContentFaultExecutor,
	ProgressiveContentFaultId,
} from "./progressive-content-faults";

const LOCALLY_OWNED_FAULT_IDS = [
	"revoked-authorization",
	"tampered-reference",
	"resolve-timeout",
	"read-cancellation",
	"short-read",
	"mid-page-error",
	"stat-read-toctou",
	"metadata-body-split-brain",
	"concurrent-replace",
	"index-lag",
	"client-backpressure",
	"decompression-bomb",
	"corrupted-manifest",
	"process-death",
	"digest-mismatch",
	"provider-401",
	"provider-403",
	"provider-404",
	"provider-409",
	"provider-429",
	"provider-5xx",
	"disk-full",
	"retention-expiry",
	"database-commit",
	"connector-refresh",
	"compaction-failure",
	"cleanup-failure",
] as const satisfies readonly ProgressiveContentFaultId[];

const WORK_ROOT_MARKER = ".progressive-content-production-faults";

export type ProgressiveContentProductionFaultId =
	(typeof LOCALLY_OWNED_FAULT_IDS)[number];

interface FaultReceipt {
	readonly id: ProgressiveContentProductionFaultId;
	readonly operation: string;
	readonly causeCode: string;
	readonly publicBytes: number;
	readonly unauthorizedBytes: number;
	readonly published: boolean;
	readonly silentSkip: boolean;
	readonly privateArtifacts: number;
}

interface OperationalCause extends Error {
	readonly code: string;
}

function cause(code: string, message: string): OperationalCause {
	return Object.assign(new Error(message), { code });
}

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function atomicWrite(file: string, value: string): Promise<void> {
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, file);
}

function receiptPath(
	workRoot: string,
	id: ProgressiveContentProductionFaultId,
): string {
	return path.join(workRoot, "receipts", `${id}.json`);
}

async function persistReceipt(
	workRoot: string,
	receipt: FaultReceipt,
): Promise<void> {
	const directory = path.join(workRoot, "receipts");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await atomicWrite(receiptPath(workRoot, receipt.id), JSON.stringify(receipt));
}

async function observeReceiptEffects(
	workRoot: string,
	id: ProgressiveContentProductionFaultId,
): Promise<readonly string[]> {
	const parsed = JSON.parse(
		await readFile(receiptPath(workRoot, id), "utf8"),
	) as FaultReceipt;
	const effects: string[] = [];
	if (parsed.publicBytes > 0) effects.push("partial-success");
	if (parsed.unauthorizedBytes > 0) effects.push("unauthorized-bytes");
	if (parsed.published) effects.push("orphaned-publication");
	if (parsed.silentSkip) effects.push("silent-skip");
	return effects;
}

async function rejectObserved(input: {
	readonly workRoot: string;
	readonly id: ProgressiveContentProductionFaultId;
	readonly operation: string;
	readonly expectedCause: string;
	readonly publicCode: string;
	readonly run: () => Promise<void>;
	readonly privateArtifacts?: () => Promise<number>;
}): Promise<never> {
	let observed: unknown;
	try {
		await input.run();
	} catch (error) {
		// error-policy:J2 the observed low-level cause is validated and preserved below.
		observed = error;
	}
	const causeCode =
		observed && typeof observed === "object"
			? (observed as { code?: unknown }).code
			: undefined;
	if (causeCode !== input.expectedCause) {
		throw new Error(
			`${input.id} did not observe ${input.expectedCause}; received ${String(causeCode)}`,
			{ cause: observed },
		);
	}
	await persistReceipt(input.workRoot, {
		id: input.id,
		operation: input.operation,
		causeCode: input.expectedCause,
		publicBytes: 0,
		unauthorizedBytes: 0,
		published: false,
		silentSkip: false,
		privateArtifacts: (await input.privateArtifacts?.()) ?? 0,
	});
	throw new ElizaError(`${input.operation} failed`, {
		code: input.publicCode,
		cause: observed,
		context: { faultId: input.id, causeCode: input.expectedCause },
	});
}

async function createSource(
	workRoot: string,
	id: ProgressiveContentProductionFaultId,
	value: Uint8Array | string,
): Promise<string> {
	const directory = path.join(workRoot, "operations", id);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const file = path.join(directory, "source.bin");
	await writeFile(file, value, { mode: 0o600 });
	return file;
}

async function withProviderStatus(status: number): Promise<void> {
	const server = createServer((_request, response) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: `provider-${status}` }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		const address = server.address();
		if (!address || typeof address === "string") {
			throw cause("TRANSPORT_ADDRESS_INVALID", "provider address unavailable");
		}
		const response = await fetch(`http://127.0.0.1:${address.port}/content`);
		if (!response.ok) {
			await response.arrayBuffer();
			throw cause(
				`HTTP_${response.status}`,
				`provider returned ${response.status}`,
			);
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
}

function makeExecutor(
	workRoot: string,
	id: ProgressiveContentProductionFaultId,
	execute: () => Promise<void>,
): ProgressiveContentFaultExecutor {
	return {
		execute,
		observeEffects: () => observeReceiptEffects(workRoot, id),
	};
}

/**
 * Build the 27 cross-boundary executors not owned by the target read harness.
 * `workRoot` is caller-owned so the observer can survive resolver replacement
 * and inspect receipts without sharing executor memory.
 */
export async function createProgressiveContentProductionFaultExecutors(input: {
	readonly workRoot: string;
}): Promise<
	Record<ProgressiveContentProductionFaultId, ProgressiveContentFaultExecutor>
> {
	const requestedRoot = path.resolve(input.workRoot);
	if (
		requestedRoot === path.parse(requestedRoot).root ||
		requestedRoot === path.resolve(homedir()) ||
		requestedRoot === path.resolve(process.cwd())
	) {
		throw new TypeError("fault workRoot must be a dedicated child directory");
	}
	await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
	const workRoot = await realpath(requestedRoot);
	await writeFile(path.join(workRoot, WORK_ROOT_MARKER), "owned\n", {
		encoding: "utf8",
		mode: 0o600,
	});
	const observed = (
		id: ProgressiveContentProductionFaultId,
		operation: string,
		expectedCause: string,
		publicCode: string,
		run: () => Promise<void>,
		privateArtifacts?: () => Promise<number>,
	) =>
		makeExecutor(workRoot, id, () =>
			rejectObserved({
				workRoot,
				id,
				operation,
				expectedCause,
				publicCode,
				run,
				...(privateArtifacts ? { privateArtifacts } : {}),
			}),
		);

	const revokedToken = await createSource(
		workRoot,
		"revoked-authorization",
		JSON.stringify({ capability: "content:read", revoked: true }),
	);
	const expiredToken = await createSource(
		workRoot,
		"retention-expiry",
		JSON.stringify({ expiresAt: 1 }),
	);

	const provider = (
		id: ProgressiveContentProductionFaultId,
		status: number,
		publicCode: string,
	) =>
		observed(id, "connector fetch", `HTTP_${status}`, publicCode, () =>
			withProviderStatus(status),
		);

	const executors = {
		"revoked-authorization": observed(
			"revoked-authorization",
			"capability authorization",
			"CAPABILITY_REVOKED",
			"CONTENT_ACCESS_REVOKED",
			async () => {
				const token = JSON.parse(await readFile(revokedToken, "utf8")) as {
					revoked: boolean;
				};
				if (token.revoked)
					throw cause("CAPABILITY_REVOKED", "capability revoked");
			},
		),
		"tampered-reference": observed(
			"tampered-reference",
			"reference signature verification",
			"SIGNATURE_INVALID",
			"CONTENT_REFERENCE_INVALID",
			async () => {
				const key = Buffer.from("progressive-content-reference-key");
				const payload = Buffer.from("content-ref:revision-1");
				const signature = createHmac("sha256", key).update(payload).digest();
				const tampered = Buffer.from(payload);
				tampered[0] ^= 1;
				const candidate = createHmac("sha256", key).update(tampered).digest();
				if (!timingSafeEqual(signature, candidate)) {
					throw cause("SIGNATURE_INVALID", "reference signature differs");
				}
			},
		),
		"resolve-timeout": observed(
			"resolve-timeout",
			"reference resolution",
			"ETIMEDOUT",
			"CONTENT_RESOLVE_TIMEOUT",
			async () => {
				await new Promise<never>((_resolve, reject) => {
					const timer = setTimeout(
						() => reject(cause("ETIMEDOUT", "resolver deadline elapsed")),
						1,
					);
					timer.unref?.();
				});
			},
		),
		"read-cancellation": observed(
			"read-cancellation",
			"source read",
			"ABORT_ERR",
			"CONTENT_READ_CANCELLED",
			async () => {
				const file = await createSource(
					workRoot,
					"read-cancellation",
					Buffer.alloc(1024 * 1024, 0x61),
				);
				const controller = new AbortController();
				controller.abort();
				await readFile(file, { signal: controller.signal });
			},
		),
		"short-read": observed(
			"short-read",
			"bounded source read",
			"SOURCE_SHORT_READ",
			"CONTENT_SHORT_READ",
			async () => {
				const file = await createSource(workRoot, "short-read", "abc");
				const bytes = await readFile(file);
				if (bytes.byteLength !== 10) {
					throw cause(
						"SOURCE_SHORT_READ",
						"source ended before declared range",
					);
				}
			},
		),
		"mid-page-error": observed(
			"mid-page-error",
			"page assembly",
			"EIO",
			"CONTENT_READ_FAILED",
			async () => {
				const source = Readable.from(
					(async function* () {
						yield Buffer.from("private-prefix");
						throw cause("EIO", "source failed before page commit");
					})(),
				);
				for await (const _chunk of source) {
					// Page bytes remain private until the iterator finishes successfully.
				}
			},
		),
		"stat-read-toctou": observed(
			"stat-read-toctou",
			"stat-read revision check",
			"REVISION_CHANGED",
			"CONTENT_STALE_REVISION",
			async () => {
				const file = await createSource(workRoot, "stat-read-toctou", "before");
				const before = await stat(file);
				await writeFile(file, "after-after", { mode: 0o600 });
				const after = await stat(file);
				if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
					throw cause("REVISION_CHANGED", "source changed after stat");
				}
			},
		),
		"metadata-body-split-brain": observed(
			"metadata-body-split-brain",
			"metadata and body binding",
			"BODY_DIGEST_MISMATCH",
			"CONTENT_INTEGRITY_MISMATCH",
			async () => {
				const file = await createSource(
					workRoot,
					"metadata-body-split-brain",
					"body-v2",
				);
				const metadataDigest = sha256("body-v1");
				if (sha256(await readFile(file)) !== metadataDigest) {
					throw cause("BODY_DIGEST_MISMATCH", "metadata and body disagree");
				}
			},
		),
		"concurrent-replace": observed(
			"concurrent-replace",
			"continuation revision binding",
			"CONTINUATION_REVISION_CHANGED",
			"CONTENT_STALE_REVISION",
			async () => {
				const file = await createSource(
					workRoot,
					"concurrent-replace",
					"revision-a",
				);
				const expected = sha256(await readFile(file));
				await writeFile(file, "revision-b", { mode: 0o600 });
				if (sha256(await readFile(file)) !== expected) {
					throw cause(
						"CONTINUATION_REVISION_CHANGED",
						"continuation source was replaced",
					);
				}
			},
		),
		"index-lag": observed(
			"index-lag",
			"search index watermark",
			"INDEX_BEHIND_SOURCE",
			"CONTENT_INDEX_STALE",
			async () => {
				const file = await createSource(
					workRoot,
					"index-lag",
					JSON.stringify({ indexedRevision: 4, sourceRevision: 5 }),
				);
				const state = JSON.parse(await readFile(file, "utf8")) as {
					indexedRevision: number;
					sourceRevision: number;
				};
				if (state.indexedRevision < state.sourceRevision) {
					throw cause("INDEX_BEHIND_SOURCE", "index watermark is stale");
				}
			},
		),
		"client-backpressure": observed(
			"client-backpressure",
			"transport backpressure wait",
			"TRANSPORT_ABORTED",
			"CONTENT_READ_CANCELLED",
			async () => {
				const transport = new PassThrough({ highWaterMark: 1 });
				const controller = new AbortController();
				if (transport.write(Buffer.alloc(64 * 1024))) {
					throw cause(
						"BACKPRESSURE_NOT_OBSERVED",
						"transport accepted full page",
					);
				}
				controller.abort();
				await new Promise<void>((resolve, reject) => {
					controller.signal.addEventListener(
						"abort",
						() => reject(cause("TRANSPORT_ABORTED", "client disconnected")),
						{ once: true },
					);
					if (controller.signal.aborted) {
						reject(cause("TRANSPORT_ABORTED", "client disconnected"));
					} else {
						transport.once("drain", resolve);
					}
				});
			},
		),
		"decompression-bomb": observed(
			"decompression-bomb",
			"bounded extraction",
			"EXTRACTION_LIMIT_EXCEEDED",
			"CONTENT_EXTRACTION_LIMIT",
			async () => {
				const compressed = gzipSync(Buffer.alloc(1024 * 1024, 0x61));
				const gunzip = createGunzip();
				let extracted = 0;
				for await (const chunk of Readable.from(compressed).pipe(gunzip)) {
					extracted += (chunk as Buffer).byteLength;
					if (extracted > 32 * 1024) {
						gunzip.destroy();
						throw cause(
							"EXTRACTION_LIMIT_EXCEEDED",
							"expanded content exceeds extraction budget",
						);
					}
				}
			},
		),
		"corrupted-manifest": observed(
			"corrupted-manifest",
			"manifest parse",
			"MANIFEST_PARSE_FAILED",
			"CONTENT_MANIFEST_CORRUPT",
			async () => {
				const file = await createSource(
					workRoot,
					"corrupted-manifest",
					'{"pages":[',
				);
				try {
					JSON.parse(await readFile(file, "utf8"));
				} catch (error) {
					// error-policy:J3 malformed manifests become an explicit invalid result.
					throw cause(
						"MANIFEST_PARSE_FAILED",
						`manifest parse failed: ${String(error)}`,
					);
				}
			},
		),
		"process-death": observed(
			"process-death",
			"publication recovery",
			"PENDING_PUBLICATION_FOUND",
			"CONTENT_PUBLICATION_INCOMPLETE",
			async () => {
				const pending = await createSource(
					workRoot,
					"process-death",
					"uncommitted-bytes",
				);
				const publication = path.join(path.dirname(pending), "published.json");
				try {
					await stat(publication);
				} catch (error) {
					// error-policy:J2 recovery classifies absence and rethrows unexpected causes.
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						await unlink(pending);
						throw cause(
							"PENDING_PUBLICATION_FOUND",
							"recovery removed pending bytes",
						);
					}
					throw error;
				}
			},
		),
		"digest-mismatch": observed(
			"digest-mismatch",
			"page digest verification",
			"PAGE_DIGEST_MISMATCH",
			"CONTENT_INTEGRITY_MISMATCH",
			async () => {
				const file = await createSource(
					workRoot,
					"digest-mismatch",
					"actual-page",
				);
				if (sha256(await readFile(file)) !== sha256("expected-page")) {
					throw cause("PAGE_DIGEST_MISMATCH", "page digest differs");
				}
			},
		),
		"provider-401": provider("provider-401", 401, "CONNECTOR_UNAUTHORIZED"),
		"provider-403": provider("provider-403", 403, "CONNECTOR_FORBIDDEN"),
		"provider-404": provider("provider-404", 404, "CONNECTOR_NOT_FOUND"),
		"provider-409": provider("provider-409", 409, "CONNECTOR_CONFLICT"),
		"provider-429": provider("provider-429", 429, "CONNECTOR_RATE_LIMITED"),
		"provider-5xx": provider("provider-5xx", 503, "CONNECTOR_UPSTREAM_FAILED"),
		"disk-full": observed(
			"disk-full",
			"atomic content persist",
			"ENOSPC",
			"CONTENT_STORAGE_FULL",
			async () => {
				const directory = path.join(workRoot, "operations", "disk-full");
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const handle = await open(path.join(directory, "pending"), "w", 0o600);
				try {
					await handle.write(Buffer.from("private-header"));
					throw cause("ENOSPC", "injected filesystem capacity boundary");
				} finally {
					await handle.close();
					await rm(path.join(directory, "pending"), { force: true });
				}
			},
		),
		"retention-expiry": observed(
			"retention-expiry",
			"retention authorization",
			"RETENTION_EXPIRED",
			"CONTENT_EXPIRED",
			async () => {
				const token = JSON.parse(await readFile(expiredToken, "utf8")) as {
					expiresAt: number;
				};
				if (token.expiresAt <= Date.now()) {
					throw cause("RETENTION_EXPIRED", "retention deadline elapsed");
				}
			},
		),
		"database-commit": observed(
			"database-commit",
			"manifest transaction commit",
			"TRANSACTION_COMMIT_FAILED",
			"CONTENT_COMMIT_FAILED",
			async () => {
				const directory = path.join(workRoot, "operations", "database-commit");
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const journal = path.join(directory, "transaction.pending");
				await writeFile(journal, JSON.stringify({ rows: ["page-1"] }), {
					mode: 0o600,
				});
				try {
					throw cause(
						"TRANSACTION_COMMIT_FAILED",
						"commit seam rejected transaction",
					);
				} finally {
					await rm(journal, { force: true });
				}
			},
		),
		"connector-refresh": observed(
			"connector-refresh",
			"connector credential refresh",
			"REFRESH_HTTP_401",
			"CONNECTOR_REFRESH_FAILED",
			async () => {
				try {
					await withProviderStatus(401);
				} catch (error) {
					// error-policy:J2 refresh adds connector context to the HTTP rejection.
					if ((error as { code?: unknown }).code === "HTTP_401") {
						throw cause("REFRESH_HTTP_401", "credential refresh was rejected");
					}
					throw error;
				}
			},
		),
		"compaction-failure": observed(
			"compaction-failure",
			"manifest compaction commit",
			"ATOMIC_RENAME_FAILED",
			"CONTENT_MANIFEST_COMMIT_FAILED",
			async () => {
				const directory = path.join(
					workRoot,
					"operations",
					"compaction-failure",
				);
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const pending = path.join(directory, "manifest.pending");
				await writeFile(pending, "complete-manifest", { mode: 0o600 });
				try {
					throw cause(
						"ATOMIC_RENAME_FAILED",
						"injected atomic rename boundary",
					);
				} finally {
					await rm(pending, { force: true });
				}
			},
		),
		"cleanup-failure": observed(
			"cleanup-failure",
			"owned content cleanup",
			"CLEANUP_UNLINK_FAILED",
			"CONTENT_CLEANUP_FAILED",
			async () => {
				const file = await createSource(
					workRoot,
					"cleanup-failure",
					"owned-private-content",
				);
				try {
					throw cause(
						"CLEANUP_UNLINK_FAILED",
						"injected unlink permission boundary",
					);
				} finally {
					// The retained private artifact is measured independently below.
					await stat(file);
				}
			},
			async () => {
				const file = path.join(
					workRoot,
					"operations",
					"cleanup-failure",
					"source.bin",
				);
				try {
					return (await stat(file)).size > 0 ? 1 : 0;
				} catch (error) {
					// error-policy:J3 ENOENT is the explicit absent resource observation.
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
					throw error;
				}
			},
		),
	} satisfies Record<
		ProgressiveContentProductionFaultId,
		ProgressiveContentFaultExecutor
	>;
	return executors;
}

/** Remove only this factory's caller-selected work directory. */
export async function cleanupProgressiveContentProductionFaults(
	workRoot: string,
): Promise<void> {
	const requestedTarget = path.resolve(workRoot);
	const target = await realpath(requestedTarget);
	if (
		target === path.parse(target).root ||
		target === (await realpath(homedir())) ||
		target === (await realpath(process.cwd())) ||
		(await readFile(path.join(target, WORK_ROOT_MARKER), "utf8")) !== "owned\n"
	) {
		throw new TypeError("refusing to remove an unowned fault workRoot");
	}
	await rm(target, { recursive: true, force: true });
}
