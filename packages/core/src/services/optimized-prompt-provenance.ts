/** Validates authenticated experiment provenance and the host configuration required to consume a bound prompt. */
export interface OptimizedPromptTargetBinding {
	provider: string;
	model: string;
	endpoint: string;
	generationConfigSha256: string;
	runtimeRevision: string;
}

export interface OptimizedPromptProvenance {
	schemaVersion: 1;
	target: OptimizedPromptTargetBinding;
	optimizerVersion: string;
	optimizerConfigSha256: string;
	datasetHashes: { train: string; validation: string; test: string };
	evaluationSha256: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return (
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function nonempty(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.trim() === value
	);
}

function sha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Returns a fresh validated binding; endpoint credentials and incidental query parameters are never provenance. */
export function parseOptimizedPromptTargetBinding(
	value: unknown,
): OptimizedPromptTargetBinding | null {
	if (
		!record(value) ||
		!exactKeys(value, [
			"provider",
			"model",
			"endpoint",
			"generationConfigSha256",
			"runtimeRevision",
		])
	)
		return null;
	if (
		!nonempty(value.provider) ||
		!nonempty(value.model) ||
		!nonempty(value.endpoint) ||
		!sha256(value.generationConfigSha256) ||
		typeof value.runtimeRevision !== "string" ||
		!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.runtimeRevision)
	)
		return null;
	let endpoint: URL;
	try {
		endpoint = new URL(value.endpoint);
	} catch {
		// error-policy:J3 A malformed configured endpoint is not a valid artifact target.
		return null;
	}
	if (
		!["https:", "http:"].includes(endpoint.protocol) ||
		!endpoint.hostname ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash
	)
		return null;
	return {
		provider: value.provider,
		model: value.model,
		endpoint: value.endpoint,
		generationConfigSha256: value.generationConfigSha256,
		runtimeRevision: value.runtimeRevision,
	};
}

/** A supplied provenance record is complete or invalid; partial reports never become authenticated experiment evidence. */
export function parseOptimizedPromptProvenance(
	value: unknown,
): OptimizedPromptProvenance | null {
	if (
		!record(value) ||
		!exactKeys(value, [
			"schemaVersion",
			"target",
			"optimizerVersion",
			"optimizerConfigSha256",
			"datasetHashes",
			"evaluationSha256",
		])
	)
		return null;
	const target = parseOptimizedPromptTargetBinding(value.target);
	const hashes = value.datasetHashes;
	if (
		value.schemaVersion !== 1 ||
		!target ||
		!nonempty(value.optimizerVersion) ||
		!sha256(value.optimizerConfigSha256) ||
		!sha256(value.evaluationSha256) ||
		!record(hashes) ||
		!exactKeys(hashes, ["train", "validation", "test"]) ||
		!sha256(hashes.train) ||
		!sha256(hashes.validation) ||
		!sha256(hashes.test)
	)
		return null;
	return {
		schemaVersion: 1,
		target,
		optimizerVersion: value.optimizerVersion,
		optimizerConfigSha256: value.optimizerConfigSha256,
		datasetHashes: {
			train: hashes.train,
			validation: hashes.validation,
			test: hashes.test,
		},
		evaluationSha256: value.evaluationSha256,
	};
}

/** Both arguments are validated records with fixed field order; every declared configuration field participates. */
export function optimizedPromptTargetsMatch(
	left: OptimizedPromptTargetBinding,
	right: OptimizedPromptTargetBinding,
): boolean {
	return (
		left.provider === right.provider &&
		left.model === right.model &&
		left.endpoint === right.endpoint &&
		left.generationConfigSha256 === right.generationConfigSha256 &&
		left.runtimeRevision === right.runtimeRevision
	);
}
