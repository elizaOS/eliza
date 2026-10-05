import { types } from "node:util";

// Browser util polyfills may expose isProxy as a throwing stub. Probe only
// trusted local objects; without native proxy detection, never inspect an
// untrusted value to grant a control-object exemption.
const detectProxy = (() => {
	const inspect = types?.isProxy;
	if (typeof inspect !== "function") return undefined;
	try {
		if (inspect({}) !== false || inspect(new Proxy({}, {})) !== true)
			return undefined;
		return inspect;
	} catch {
		return undefined;
	}
})();

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
	if (!detectProxy || !signalPrototype || !abortedGetter || detectProxy(value))
		return false;
	if (Object.getPrototypeOf(value) !== signalPrototype) return false;
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || typeof key === "string" || !("value" in descriptor))
			return false;
	}
	try {
		return typeof abortedGetter.call(value) === "boolean";
	} catch {
		return false;
	}
}
