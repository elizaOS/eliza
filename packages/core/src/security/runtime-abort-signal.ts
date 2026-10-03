import { types } from "node:util";

const signalPrototype =
	typeof AbortSignal === "undefined" ? undefined : AbortSignal.prototype;
const abortedGetter =
	signalPrototype &&
	Object.getOwnPropertyDescriptor(signalPrototype, "aborted")?.get;

/** Only undecorated native control objects bypass a data-only redaction walk.
 * Reject proxies before prototype/property inspection; Node signal getters use
 * internal symbol reads and must never run against an untrusted proxy/accessor.
 * All other values stay in the existing bounded descriptor-only walker.
 */
export function isRuntimeAbortSignal(value: object): boolean {
	if (!signalPrototype || !abortedGetter || types.isProxy(value)) return false;
	if (Object.getPrototypeOf(value) !== signalPrototype) return false;
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if (typeof key === "string" || !("value" in descriptor)) return false;
	}
	try {
		return typeof abortedGetter.call(value) === "boolean";
	} catch {
		return false;
	}
}
