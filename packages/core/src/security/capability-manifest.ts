/**
 * Per-tool-call capability governance for elizaOS actions (issue #9235).
 *
 * elizaOS already isolates the *whole agent* in a Bun Worker sandbox and gates
 * plugins coarsely via `RemotePluginPermissions`. This adds a thin, OPT-IN,
 * fine-grained layer on top — a per-call capability manifest — without a nested
 * sandbox and without changing any action that doesn't ask for it. Wrapping an
 * action with {@link withCapabilityGovernance} is additive: the wrapped handler
 * runs under the manifest, every other action is untouched.
 *
 * Honest scope (so nobody over-trusts this):
 *  - `cpuMs` is enforced for real as a **wall-clock deadline** — the handler is
 *    raced against a timer and rejected with {@link CapabilityDeadlineError} if
 *    it overruns. (True CPU-time accounting needs a worker; the deadline is the
 *    pragmatic, testable bound that stops a runaway tool call.)
 *  - `allowedHosts` / `allowedPaths` are **predicates** ({@link isHostAllowed},
 *    {@link isPathAllowed}) that the network / filesystem layers consult — this
 *    module does not monkeypatch `fetch` or `fs`. Pair it with the existing
 *    SSRF guard (`@elizaos/core/network`) at the call site.
 *  - `env` is exposed as a **frozen snapshot** ({@link frozenEnv}) for the call
 *    to read instead of the ambient `process.env`.
 *
 * @module security/capability-manifest
 */

import type { Action } from "../types/components.ts";

/** A per-call capability budget. Every field is optional — an empty manifest is a no-op. */
export interface CapabilityManifest {
	/** Wall-clock deadline for the call in milliseconds. Omit for no deadline. */
	cpuMs?: number;
	/** Hostnames the call may reach. Omit to allow any host (no network policy). */
	allowedHosts?: readonly string[];
	/** Absolute, normalized path roots the call may touch. Omit to allow any path. */
	allowedPaths?: readonly string[];
	/** Frozen environment the call should see instead of the ambient process env. */
	env?: Readonly<Record<string, string>>;
}

/** Thrown when a governed call overruns its `cpuMs` deadline. */
export class CapabilityDeadlineError extends Error {
	constructor(public readonly cpuMs: number) {
		super(`Capability deadline exceeded: call ran longer than ${cpuMs}ms`);
		this.name = "CapabilityDeadlineError";
	}
}

/** Thrown when a governed call attempts a host/path the manifest disallows. */
export class CapabilityViolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CapabilityViolationError";
	}
}

/**
 * Run `task` under the manifest's wall-clock deadline. Resolves with the task's
 * value, or rejects with {@link CapabilityDeadlineError} if it overruns `cpuMs`.
 * With no `cpuMs`, the task runs unbounded (the manifest imposes no time policy).
 *
 * The timer is always cleared so a fast task leaves no dangling handle.
 */
export function applyCapabilityManifest<T>(
	task: () => Promise<T>,
	manifest: CapabilityManifest,
): Promise<T> {
	const { cpuMs } = manifest;
	if (cpuMs === undefined || !Number.isFinite(cpuMs) || cpuMs <= 0) {
		return task();
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new CapabilityDeadlineError(cpuMs));
		}, cpuMs);
		// Unref so a pending deadline never keeps the process alive on its own.
		(timer as { unref?: () => void }).unref?.();
		task().then(
			(value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** Lowercase + strip brackets from a hostname for comparison. */
function normalizeHost(host: string): string {
	return host
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
}

/**
 * Whether `host` is permitted by the manifest. With no `allowedHosts` the
 * manifest imposes no network policy and every host is allowed. An allowlist
 * entry matches the exact host OR any subdomain of it (`example.com` allows
 * `api.example.com`); a leading-dot entry (`.example.com`) matches subdomains
 * only, not the apex.
 */
export function isHostAllowed(
	host: string,
	manifest: CapabilityManifest,
): boolean {
	if (!manifest.allowedHosts) return true;
	const h = normalizeHost(host);
	if (!h) return false;
	return manifest.allowedHosts.some((raw) => {
		const entry = normalizeHost(raw);
		if (!entry) return false;
		if (entry.startsWith(".")) return h.endsWith(entry);
		return h === entry || h.endsWith(`.${entry}`);
	});
}

/** Assert `host` is allowed, throwing {@link CapabilityViolationError} otherwise. */
export function assertHostAllowed(
	host: string,
	manifest: CapabilityManifest,
): void {
	if (!isHostAllowed(host, manifest)) {
		throw new CapabilityViolationError(
			`Host not in capability allowlist: ${host}`,
		);
	}
}

/**
 * Whether `path` is under one of the manifest's `allowedPaths` roots. With no
 * `allowedPaths` every path is allowed. A path containing a `..` traversal
 * segment is always rejected. Matching is exact-root or root-prefixed
 * (`/data` allows `/data/x` but not `/database`).
 */
export function isPathAllowed(
	path: string,
	manifest: CapabilityManifest,
): boolean {
	if (!manifest.allowedPaths) return true;
	const p = path.trim();
	if (!p || p.split(/[\\/]/).includes("..")) return false;
	return manifest.allowedPaths.some((root) => {
		const r = root.trim().replace(/[\\/]+$/, "");
		return p === r || p.startsWith(`${r}/`);
	});
}

/** Assert `path` is allowed, throwing {@link CapabilityViolationError} otherwise. */
export function assertPathAllowed(
	path: string,
	manifest: CapabilityManifest,
): void {
	if (!isPathAllowed(path, manifest)) {
		throw new CapabilityViolationError(
			`Path not in capability allowlist: ${path}`,
		);
	}
}

/** The frozen env map the governed call should read (empty when none configured). */
export function frozenEnv(
	manifest: CapabilityManifest,
): Readonly<Record<string, string>> {
	return Object.freeze({ ...(manifest.env ?? {}) });
}

/**
 * Wrap an {@link Action} so its handler runs under `manifest`. Every other field
 * (name, description, validate, similes, …) is preserved; only the handler is
 * re-bound to enforce the manifest's deadline. The action's behavior is
 * otherwise unchanged — this composes with, and never replaces, the Bun Worker
 * isolation the whole agent already runs in.
 */
export function withCapabilityGovernance(
	action: Action,
	manifest: CapabilityManifest,
): Action {
	const innerHandler = action.handler;
	return {
		...action,
		handler: (runtime, message, state, options, callback, responses) =>
			applyCapabilityManifest(
				() =>
					innerHandler(runtime, message, state, options, callback, responses),
				manifest,
			),
	};
}
