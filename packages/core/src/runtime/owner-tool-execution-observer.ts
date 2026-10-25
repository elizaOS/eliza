/** Read-only canonical tool observation. No observer means no projection or I/O. */
import { isSensitiveKeyName, redactSensitiveText } from "../security/redact";
import { getTrajectoryContext } from "../trajectory-context";
import type {
	IAgentRuntime,
	OwnerToolExecutionObservation,
} from "../types/runtime";

const encoder = new TextEncoder();
const excluded = new Set([
	"headers",
	"authorization",
	"reasoning",
	"thought",
	"analysis",
	"scratchpad",
	"__proto__",
	"prototype",
	"constructor",
]);

export function observeOwnerToolExecution(
	runtime: IAgentRuntime,
	value: () => Omit<
		OwnerToolExecutionObservation,
		"redactedFields" | "redactedStrings" | "omittedFields"
	>,
): void {
	let observer: IAgentRuntime["ownerToolExecutionObserver"];
	try {
		observer = runtime.ownerToolExecutionObserver;
	} catch {
		return;
	}
	if (typeof observer !== "function") return;
	const invoke = observer;
	const dispatch = (event: Readonly<OwnerToolExecutionObservation>): void => {
		try {
			const returned: unknown = invoke(event);
			if (returned !== undefined)
				void Promise.resolve(returned).catch(() => {});
		} catch {
			/* Synchronous and asynchronous observer failures are isolated. */
		}
	};
	const stats = { redactedFields: 0, redactedStrings: 0, omittedFields: 0 };
	let nodes = 0;
	let bytes = 0;
	let knownSecrets: Array<{ value: string }> = [];
	let secretLookupAvailable = true;
	try {
		knownSecrets = getTrajectoryContext()?.secretSwapSession?.entries ?? [];
	} catch {
		secretLookupAvailable = false;
	}
	const redact = (text: string): string => {
		const projected = redactSensitiveText(runtime.redactSecrets(text));
		if (
			projected !== text ||
			knownSecrets.some(
				(entry) => entry.value.length > 0 && text.includes(entry.value),
			)
		) {
			stats.redactedStrings += 1;
			return "[credential redacted]";
		}
		return text;
	};
	const clone = (input: unknown, depth = 0): unknown => {
		if (++nodes > 30_000 || depth > 24) {
			stats.omittedFields += 1;
			return "[omitted: structure limit]";
		}
		if (input === null || typeof input === "boolean" || input === undefined)
			return input ?? null;
		if (typeof input === "number") {
			if (!Number.isFinite(input)) {
				stats.omittedFields += 1;
				return null;
			}
			return input;
		}
		if (typeof input === "string") {
			bytes += encoder.encode(input).byteLength;
			if (bytes > 1024 * 1024) {
				stats.omittedFields += 1;
				return "[omitted: byte limit]";
			}
			return redact(input);
		}
		if (typeof input !== "object") {
			stats.omittedFields += 1;
			return null;
		}
		if (Array.isArray(input)) {
			if (input.length > 30_000) stats.omittedFields += 1;
			return Object.freeze(
				input.slice(0, 30_000).map((part) => clone(part, depth + 1)),
			);
		}
		const prototype = Object.getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null) {
			stats.omittedFields += 1;
			return "[omitted: non-JSON object]";
		}
		const out: Record<string, unknown> = Object.create(null);
		for (const [name, descriptor] of Object.entries(
			Object.getOwnPropertyDescriptors(input),
		)) {
			if (nodes > 30_000 || bytes > 1024 * 1024) {
				stats.omittedFields += 1;
				break;
			}
			if (!descriptor.enumerable) continue;
			if ("value" in descriptor && descriptor.value === undefined) continue;
			if (excluded.has(name.toLowerCase()) || isSensitiveKeyName(name)) {
				stats.redactedFields += 1;
				continue;
			}
			if (!("value" in descriptor)) {
				stats.omittedFields += 1;
				continue;
			}
			bytes += encoder.encode(name).byteLength + 4;
			out[name] = clone(descriptor.value, depth + 1);
		}
		return Object.freeze(out);
	};
	try {
		if (!secretLookupAvailable)
			throw new Error("OWNER_OBSERVATION_SECRET_SCOPE_UNAVAILABLE");
		const original = value();
		const args = original.args === undefined ? undefined : clone(original.args);
		const result =
			original.result === undefined ? undefined : clone(original.result);
		const event = Object.freeze({
			phase: original.phase,
			gate: original.gate,
			gateOutcome: original.gateOutcome,
			actionName: redact(original.actionName),
			...(original.executionId ? { executionId: original.executionId } : {}),
			...(original.toolCallId
				? { toolCallId: redact(original.toolCallId) }
				: {}),
			...(original.args !== undefined ? { args } : {}),
			...(original.result !== undefined ? { result } : {}),
			...stats,
		});
		dispatch(event);
	} catch {
		// Never rethrow, report raw values, await an observer, or alter execution.
		try {
			dispatch(
				Object.freeze({
					phase: "omitted",
					gate: "execution",
					gateOutcome: "unknown",
					actionName: "unknown",
					redactedFields: 0,
					redactedStrings: 0,
					omittedFields: 1,
				}),
			);
		} catch {
			/* A broken private observer cannot change canonical execution. */
		}
	}
}
