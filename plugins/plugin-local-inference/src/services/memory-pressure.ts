/**
 * Cross-platform memory-pressure sources for the Memory Arbiter (WS1).
 *
 * The arbiter consumes a `MemoryPressureSource` interface so it doesn't
 * care whether the signal comes from polling `os.freemem()`, an Android
 * `ComponentCallbacks2.onTrimMemory()` callback, or an iOS
 * `UIApplicationDidReceiveMemoryWarningNotification` subscription.
 *
 * Three concrete implementations live here:
 *
 *   1. `nodeOsPressureSource` — desktop / server. Polls `os.freemem()` /
 *      `os.totalmem()` on a fixed cadence (~5 s). Emits `nominal` /
 *      `low` / `critical` from a two-threshold high-water mark over total
 *      RAM. The polling timer is `unref`'d so it never holds the process
 *      open.
 *
 *   2. `capacitorPressureSource` — Capacitor iOS/Android shim. The native
 *      side (Android `ComponentCallbacks2.onTrimMemory`, iOS
 *      `UIApplicationDidReceiveMemoryWarningNotification`) calls
 *      `dispatch(level)` via the bridge, which fans the level out to
 *      arbiter listeners. The JS contract is fixed here; the native
 *      modules will be wired in WS2 / WS8.
 *
 *   3. `compositePressureSource` — combine sources (e.g. one OS poll +
 *      one Capacitor bridge). The composite emits the *worst* reported
 *      level so neither signal can mask the other.
 *
 * Pressure semantics — what each level means to the arbiter:
 *   - `nominal`  → no action; the arbiter may load freely.
 *   - `low`      → the arbiter SHOULD evict the lowest-priority resident
 *                   role and may pause optimistic preloads.
 *   - `critical` → the arbiter MUST evict every non-text-target role
 *                   immediately; `acquire()` for non-text capabilities is
 *                   allowed to throw.
 *
 * No fallback sludge:
 *   - When a probe fails (e.g. `os.freemem()` returns NaN under sandboxing),
 *     the source emits `nominal` and logs a warning. It does NOT pretend
 *     the system is critical and start trashing models.
 *   - `dispatch(level)` from a native bridge is trusted; the JS layer does
 *     not second-guess it with its own poll.
 */

import os from "node:os";

/** Pressure level the arbiter consumes. */
export type MemoryPressureLevel = "nominal" | "low" | "critical";

export interface MemoryPressureEvent {
	level: MemoryPressureLevel;
	/** Optional free RAM, MB. Present for poll-based sources; absent for OS-callback bridges. */
	freeMb?: number;
	/** Optional total RAM, MB. */
	totalMb?: number;
	/** Free as a fraction of total (0..1). Present when both above are present. */
	freeFraction?: number;
	/** Source identifier — handy for telemetry. `os-poll` / `capacitor` / `composite`. */
	source: string;
	/** Wall-clock ms when the event was generated. */
	atMs: number;
}

export type MemoryPressureListener = (event: MemoryPressureEvent) => void;

export interface MemoryPressureSource {
	/** Stable identifier for the source (used in telemetry tags). */
	readonly id: string;
	/** Subscribe to pressure events. Returns the unsubscribe fn. */
	subscribe(listener: MemoryPressureListener): () => void;
	/** Begin observing. Idempotent. */
	start(): void;
	/** Stop observing. Idempotent. */
	stop(): void;
	/** Take a one-shot reading without subscribing. May reuse the cached level. */
	current(): MemoryPressureEvent;
}

const BYTES_PER_MB = 1024 * 1024;

export interface NodeOsPressureConfig {
	/** Poll interval, ms. Default 5000 (5 s); min 500 ms. */
	intervalMs: number;
	/**
	 * Below this fraction of total RAM, level becomes `low`. Default 0.15.
	 */
	lowWaterFraction: number;
	/**
	 * Below this fraction of total RAM, level becomes `critical`. Default 0.05.
	 * Must be < lowWaterFraction; the source enforces this at construction.
	 */
	criticalWaterFraction: number;
	/** Optional injected clock (testing). Defaults to `Date.now()`. */
	now?: () => number;
}

export interface NodeOsPressureSources {
	/** OS free/total memory in bytes. Defaults to `os.freemem()/os.totalmem()`. */
	osMemory?: () => { freeBytes: number; totalBytes: number };
	/** Optional logger; warnings only. */
	logger?: { warn?: (m: string) => void };
}

const NODE_OS_DEFAULTS: NodeOsPressureConfig = {
	intervalMs: 5_000,
	lowWaterFraction: 0.15,
	criticalWaterFraction: 0.05,
};

/**
 * Polling pressure source for desktop/server. The poll happens on an
 * `unref`'d timer so the process can exit naturally. Listeners only fire
 * when the level *changes* (or the first time after `start()`); raw
 * readings are still available via `current()` for logging.
 */
export function nodeOsPressureSource(
	overrides: Partial<NodeOsPressureConfig> = {},
	sources: NodeOsPressureSources = {},
): MemoryPressureSource {
	const config: NodeOsPressureConfig = {
		intervalMs: Math.max(500, overrides.intervalMs ?? NODE_OS_DEFAULTS.intervalMs),
		lowWaterFraction: clampFraction(overrides.lowWaterFraction, NODE_OS_DEFAULTS.lowWaterFraction),
		criticalWaterFraction: clampFraction(
			overrides.criticalWaterFraction,
			NODE_OS_DEFAULTS.criticalWaterFraction,
		),
		now: overrides.now,
	};
	if (config.criticalWaterFraction >= config.lowWaterFraction) {
		throw new Error(
			`[memory-pressure] criticalWaterFraction (${config.criticalWaterFraction}) must be < lowWaterFraction (${config.lowWaterFraction})`,
		);
	}
	const probe =
		sources.osMemory ??
		(() => ({ freeBytes: os.freemem(), totalBytes: os.totalmem() }));
	const now = config.now ?? (() => Date.now());
	const listeners = new Set<MemoryPressureListener>();
	let timer: NodeJS.Timeout | null = null;
	let lastLevel: MemoryPressureLevel | null = null;
	let lastEvent: MemoryPressureEvent = {
		level: "nominal",
		source: "os-poll",
		atMs: now(),
	};

	const sample = (): MemoryPressureEvent => {
		const { freeBytes, totalBytes } = probe();
		const totalMb = Math.round(totalBytes / BYTES_PER_MB);
		const freeMb = Math.round(freeBytes / BYTES_PER_MB);
		if (!Number.isFinite(freeMb) || !Number.isFinite(totalMb) || totalMb <= 0) {
			sources.logger?.warn?.(
				`[memory-pressure] os memory probe returned invalid (free=${freeMb}, total=${totalMb}); reporting nominal`,
			);
			return { level: "nominal", source: "os-poll", atMs: now() };
		}
		const freeFraction = freeMb / totalMb;
		const level: MemoryPressureLevel =
			freeFraction <= config.criticalWaterFraction
				? "critical"
				: freeFraction <= config.lowWaterFraction
					? "low"
					: "nominal";
		return { level, freeMb, totalMb, freeFraction, source: "os-poll", atMs: now() };
	};

	const tick = (): void => {
		const event = sample();
		lastEvent = event;
		if (lastLevel === event.level) return;
		lastLevel = event.level;
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				// Listener faults should never crash the poller. Drop it.
				listeners.delete(listener);
			}
		}
	};

	return {
		id: "os-poll",
		subscribe(listener) {
			listeners.add(listener);
			// Fire the current level immediately so subscribers can react without
			// waiting a full interval.
			try {
				listener(lastEvent);
			} catch {
				listeners.delete(listener);
			}
			return () => {
				listeners.delete(listener);
			};
		},
		start() {
			if (timer) return;
			tick();
			const t = setInterval(tick, config.intervalMs);
			t.unref();
			timer = t;
		},
		stop() {
			if (!timer) return;
			clearInterval(timer);
			timer = null;
		},
		current(): MemoryPressureEvent {
			return sample();
		},
	};
}

function clampFraction(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0 || value >= 1) return fallback;
	return value;
}

/**
 * Capacitor-side bridge. The native module dispatches a level whenever
 * the OS hands it a memory-pressure callback (Android: `onTrimMemory`,
 * mapping `TRIM_MEMORY_RUNNING_LOW`/`TRIM_MEMORY_RUNNING_CRITICAL` to
 * `low`/`critical`; iOS: `didReceiveMemoryWarning` → `critical`). The JS
 * surface is `dispatch(level, freeMb?)`. The host wires this to the
 * Capacitor plugin in WS2/WS8; here we own the contract + JS state.
 */
export interface CapacitorPressureSource extends MemoryPressureSource {
	/** Called by the Capacitor native bridge whenever the OS signals pressure. */
	dispatch(level: MemoryPressureLevel, freeMb?: number): void;
}

export function capacitorPressureSource(
	opts: { now?: () => number } = {},
): CapacitorPressureSource {
	const now = opts.now ?? (() => Date.now());
	const listeners = new Set<MemoryPressureListener>();
	let lastEvent: MemoryPressureEvent = {
		level: "nominal",
		source: "capacitor",
		atMs: now(),
	};
	let started = false;
	return {
		id: "capacitor",
		subscribe(listener) {
			listeners.add(listener);
			try {
				listener(lastEvent);
			} catch {
				listeners.delete(listener);
			}
			return () => {
				listeners.delete(listener);
			};
		},
		start() {
			started = true;
		},
		stop() {
			started = false;
		},
		current(): MemoryPressureEvent {
			return lastEvent;
		},
		dispatch(level: MemoryPressureLevel, freeMb?: number): void {
			if (!started) {
				// Allow dispatch even before start() so the boot path can pre-load
				// state from a recent OS callback; we just don't gate on it.
			}
			const event: MemoryPressureEvent = {
				level,
				source: "capacitor",
				atMs: now(),
				...(freeMb !== undefined ? { freeMb } : {}),
			};
			lastEvent = event;
			for (const listener of listeners) {
				try {
					listener(event);
				} catch {
					listeners.delete(listener);
				}
			}
		},
	};
}

/**
 * Combine multiple sources. Subscribers see the *worst* level reported by
 * any underlying source — once a critical signal arrives, the composite
 * stays critical until every source returns to nominal/low.
 */
export function compositePressureSource(
	sources: ReadonlyArray<MemoryPressureSource>,
	opts: { now?: () => number } = {},
): MemoryPressureSource {
	const now = opts.now ?? (() => Date.now());
	const lastBySource = new Map<string, MemoryPressureEvent>();
	const listeners = new Set<MemoryPressureListener>();
	const subs: Array<() => void> = [];

	const worst = (): MemoryPressureEvent => {
		let level: MemoryPressureLevel = "nominal";
		let freeMb: number | undefined;
		let totalMb: number | undefined;
		for (const e of lastBySource.values()) {
			if (rank(e.level) > rank(level)) {
				level = e.level;
				freeMb = e.freeMb;
				totalMb = e.totalMb;
			}
		}
		const event: MemoryPressureEvent = {
			level,
			source: "composite",
			atMs: now(),
		};
		if (freeMb !== undefined) event.freeMb = freeMb;
		if (totalMb !== undefined) event.totalMb = totalMb;
		if (freeMb !== undefined && totalMb !== undefined && totalMb > 0) {
			event.freeFraction = freeMb / totalMb;
		}
		return event;
	};

	const fanout = (): void => {
		const event = worst();
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				listeners.delete(listener);
			}
		}
	};

	let started = false;
	let lastLevel: MemoryPressureLevel | null = null;

	const handle = (e: MemoryPressureEvent): void => {
		lastBySource.set(e.source, e);
		const w = worst();
		if (lastLevel === w.level) return;
		lastLevel = w.level;
		fanout();
	};

	return {
		id: "composite",
		subscribe(listener) {
			listeners.add(listener);
			try {
				listener(worst());
			} catch {
				listeners.delete(listener);
			}
			return () => {
				listeners.delete(listener);
			};
		},
		start() {
			if (started) return;
			started = true;
			for (const s of sources) {
				s.start();
				subs.push(s.subscribe(handle));
			}
		},
		stop() {
			if (!started) return;
			started = false;
			while (subs.length) {
				const u = subs.pop();
				try {
					u?.();
				} catch {
					// Ignore — unsubscribe must never throw out.
				}
			}
			for (const s of sources) s.stop();
			lastBySource.clear();
			lastLevel = null;
		},
		current(): MemoryPressureEvent {
			return worst();
		},
	};
}

function rank(level: MemoryPressureLevel): number {
	if (level === "critical") return 2;
	if (level === "low") return 1;
	return 0;
}
