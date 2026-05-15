/**
 * NetworkPolicy bridge for `plugin-local-inference` (R5-versioning §4).
 *
 * The shared module `@elizaos/shared/local-inference/network-policy` defines
 * the platform-agnostic classifier + decision rule. This module wires the
 * platform-specific probes:
 *
 * - **Android** (Capacitor / AOSP runtime): `@capacitor/network`'s
 *   `Network.getStatus()` for connection type, plus an explicit native
 *   shim (`getMeteredHint`) that reads `NetworkCapabilities.hasCapability(
 *   NET_CAPABILITY_NOT_METERED)`. Android docs explicitly warn against
 *   equating "cellular" with "metered" — the metered flag is mandatory.
 * - **iOS** (Capacitor / native): `@capacitor/network` for connection type
 *   plus our native bridge that reads `NWPathMonitor.path.isExpensive`.
 *   `isExpensive == true` is Apple's "treat as metered" flag.
 * - **Desktop** (Electron/Electrobun): platform-specific OS shims —
 *   WinRT `NetworkCostType` on Windows, NetworkManager dbus
 *   `ActiveConnection.Metered` on Linux, `NWPathMonitor` on macOS.
 *   When no shim is available, falls back to `metered: false` on a wired
 *   link and `metered: null` (unknown) on Wi-Fi; the policy turns
 *   `unknown` into `ask` so the user is never surprised.
 * - **Headless server / CLI** (`ELIZA_NETWORK_POLICY=headless` or
 *   `process.stdout.isTTY === false && process.env.CI !== undefined`):
 *   skip auto-update entirely. The `milady models update` CLI invocation
 *   still works, but the runtime tick is silent.
 *
 * The Capacitor / native bridges that hook into the global `window`
 * object on mobile are installed by the AOSP / iOS plugin layers; this
 * module reads them through an injectable adapter so the server-side
 * runtime stays platform-pure and tests can drive the state machine
 * without any of the native dependencies.
 *
 * Spec: `.swarm/research/R5-versioning.md` §4.
 */

import {
	applyNetworkPolicy,
	classifyNetwork,
	DEFAULT_NETWORK_POLICY_PREFERENCES,
	type NetworkClass,
	type NetworkPolicyDecision,
	type NetworkPolicyPreferences,
	type RawNetworkState,
} from "@elizaos/shared";

/**
 * Platform probe — produces a `RawNetworkState` from whatever OS API is
 * available. Each platform shim implements this; the registry below picks
 * the active one at runtime.
 */
export interface NetworkProbe {
	readonly id:
		| "node-default"
		| "capacitor-android"
		| "capacitor-ios"
		| "electron-darwin"
		| "electron-win32"
		| "electron-linux"
		| "headless";
	probe(): Promise<RawNetworkState>;
}

/**
 * Heuristic: are we running headless (no TTY, in CI, or with an explicit
 * override)? Headless callers should NOT auto-update because there is no
 * one around to confirm a multi-GB download.
 */
export function isHeadlessRuntime(): boolean {
	if (process.env.ELIZA_NETWORK_POLICY === "headless") return true;
	if (process.env.ELIZA_HEADLESS === "1") return true;
	if (process.env.CI !== undefined && process.env.CI !== "false") return true;
	if (typeof process.stdout.isTTY === "boolean" && !process.stdout.isTTY) {
		// On a Linux server with no TTY this is a strong "headless" signal;
		// but a packaged Electron app also has no TTY. Use the explicit env
		// override above when we want to force one way or the other.
		// Default: only headless when ALSO no DISPLAY / no Wayland session.
		if (
			process.platform === "linux" &&
			!process.env.DISPLAY &&
			!process.env.WAYLAND_DISPLAY
		) {
			return true;
		}
	}
	return false;
}

/**
 * Default Node probe — returns `unknown` for everything. Useful in tests
 * and on packaged servers where there is no Capacitor / Electron bridge.
 * The policy will downgrade `unknown` to `ask`, which is correct for the
 * platform-uncertain case.
 */
export const NODE_DEFAULT_PROBE: NetworkProbe = {
	id: "node-default",
	async probe(): Promise<RawNetworkState> {
		return { connectionType: "unknown", metered: null };
	},
};

/**
 * Headless probe — fires when `isHeadlessRuntime()` is true. The decision
 * rule short-circuits to `headless-explicit-only` regardless of state.
 */
export const HEADLESS_PROBE: NetworkProbe = {
	id: "headless",
	async probe(): Promise<RawNetworkState> {
		return { connectionType: "unknown", metered: null };
	},
};

/**
 * Capacitor Android probe (R5 §4.1).
 *
 * Reads connection type from `@capacitor/network` and metered status from
 * a native shim exposed at `(window as any).ElizaNetworkPolicy` (provided
 * by the `@elizaos/capacitor-network-policy` Capacitor plugin at
 * `packages/native-plugins/network-policy/`). Importing the plugin from
 * the app bootstrap installs `globalThis.ElizaNetworkPolicy` via the
 * plugin's `installNetworkPolicyGlobal()` side-effect, so the runtime
 * picks it up automatically. When the shim is missing the metered flag
 * falls back to `null` (= unknown), which triggers `ask` per R5 §4.1.
 */
export function capacitorAndroidProbe(): NetworkProbe {
	return {
		id: "capacitor-android",
		async probe(): Promise<RawNetworkState> {
			const cap = readGlobalCapacitor();
			const status = await cap?.Network?.getStatus?.();
			const ctype: RawNetworkState["connectionType"] =
				status?.connectionType === "wifi"
					? "wifi"
					: status?.connectionType === "cellular"
						? "cellular"
						: status?.connectionType === "none"
							? "none"
							: "unknown";
			const meteredHint = await readAndroidMeteredShim();
			return { connectionType: ctype, metered: meteredHint };
		},
	};
}

/**
 * Capacitor iOS probe (R5 §4.2). Connection type from `@capacitor/network`
 * plus iOS `NWPathMonitor.currentPath.isExpensive` via the
 * `@elizaos/capacitor-network-policy` Capacitor plugin at
 * `packages/native-plugins/network-policy/`. The plugin exposes
 * `(window as any).ElizaNetworkPolicy.getPathHints()`; falls back to
 * `metered: null` when the bridge is missing.
 */
export function capacitorIosProbe(): NetworkProbe {
	return {
		id: "capacitor-ios",
		async probe(): Promise<RawNetworkState> {
			const cap = readGlobalCapacitor();
			const status = await cap?.Network?.getStatus?.();
			const ctype: RawNetworkState["connectionType"] =
				status?.connectionType === "wifi"
					? "wifi"
					: status?.connectionType === "cellular"
						? "cellular"
						: status?.connectionType === "none"
							? "none"
							: "unknown";
			const hints = await readIosPathHintsShim();
			const metered = hints === null ? null : Boolean(hints.isExpensive);
			return { connectionType: ctype, metered };
		},
	};
}

/**
 * Electron / desktop probe. Calls into a process-bridge-exposed function
 * (Electrobun: `Bun.napi`/`electrobunNative.networkPolicyProbe`; classic
 * Electron: `electronAPI.networkPolicyProbe`) that wraps the OS call.
 * Returns `unknown` when no bridge is wired (development-mode browser
 * preview), which downgrades to `ask` on `wifi-*` and `auto` on
 * `ethernet-unmetered` per the matrix.
 */
export function electronDesktopProbe(): NetworkProbe {
	const detectId = (): NetworkProbe["id"] => {
		if (process.platform === "darwin") return "electron-darwin";
		if (process.platform === "win32") return "electron-win32";
		return "electron-linux";
	};
	return {
		id: detectId(),
		async probe(): Promise<RawNetworkState> {
			const bridge = readGlobalDesktopBridge();
			if (!bridge) return { connectionType: "unknown", metered: null };
			try {
				const res = await bridge.networkPolicyProbe();
				return {
					connectionType: res.connectionType ?? "unknown",
					metered: res.metered ?? null,
				};
			} catch {
				return { connectionType: "unknown", metered: null };
			}
		},
	};
}

interface CapacitorBridge {
	Network?: {
		getStatus?: () => Promise<{
			connected?: boolean;
			connectionType?: "wifi" | "cellular" | "none" | "unknown";
		}>;
	};
}

function readGlobalCapacitor(): CapacitorBridge | null {
	const g = globalThis as unknown as {
		Capacitor?: { Plugins?: CapacitorBridge };
	};
	return g.Capacitor?.Plugins ?? null;
}

interface AndroidMeteredShim {
	getMeteredHint?: () => Promise<{ metered?: boolean }>;
}
interface IosPathHintsShim {
	getPathHints?: () => Promise<{
		isExpensive?: boolean;
		isConstrained?: boolean;
	}>;
}

async function readAndroidMeteredShim(): Promise<boolean | null> {
	const g = globalThis as unknown as {
		ElizaNetworkPolicy?: AndroidMeteredShim;
	};
	const fn = g.ElizaNetworkPolicy?.getMeteredHint;
	if (typeof fn !== "function") return null;
	try {
		const res = await fn();
		return typeof res.metered === "boolean" ? res.metered : null;
	} catch {
		return null;
	}
}

async function readIosPathHintsShim(): Promise<{
	isExpensive: boolean;
	isConstrained: boolean;
} | null> {
	const g = globalThis as unknown as { ElizaNetworkPolicy?: IosPathHintsShim };
	const fn = g.ElizaNetworkPolicy?.getPathHints;
	if (typeof fn !== "function") return null;
	try {
		const res = await fn();
		return {
			isExpensive: Boolean(res.isExpensive),
			isConstrained: Boolean(res.isConstrained),
		};
	} catch {
		return null;
	}
}

interface DesktopBridge {
	networkPolicyProbe(): Promise<{
		connectionType?: RawNetworkState["connectionType"];
		metered?: boolean | null;
	}>;
}

function readGlobalDesktopBridge(): DesktopBridge | null {
	const g = globalThis as unknown as {
		electrobunNative?: DesktopBridge;
		electronAPI?: DesktopBridge;
	};
	return g.electrobunNative ?? g.electronAPI ?? null;
}

/**
 * Pick the active probe based on platform heuristics. Order:
 *
 * 1. `ELIZA_NETWORK_POLICY=headless` (or CI / no-TTY-no-DISPLAY) → headless.
 * 2. Capacitor android bridge present → Android probe.
 * 3. Capacitor iOS bridge present → iOS probe (`process.platform` !==
 *    `android` and a `Capacitor` global exists).
 * 4. Desktop bridge present → desktop probe.
 * 5. Otherwise → node-default (returns `unknown`).
 */
export function pickActiveProbe(): NetworkProbe {
	if (isHeadlessRuntime()) return HEADLESS_PROBE;
	const g = globalThis as unknown as {
		Capacitor?: { getPlatform?: () => string };
	};
	const platform = g.Capacitor?.getPlatform?.();
	if (platform === "android") return capacitorAndroidProbe();
	if (platform === "ios") return capacitorIosProbe();
	if (readGlobalDesktopBridge() !== null) return electronDesktopProbe();
	return NODE_DEFAULT_PROBE;
}

/**
 * High-level: probe + classify + apply prefs in one call. Used by the
 * voice-model updater and by the local-inference download routes.
 */
export async function evaluateRuntimePolicy(args: {
	prefs?: NetworkPolicyPreferences;
	estimatedBytes: number;
	probe?: NetworkProbe;
	now?: Date;
}): Promise<NetworkPolicyDecision> {
	const probe = args.probe ?? pickActiveProbe();
	const state = await probe.probe();
	const klass = classifyNetwork(state);
	const isHeadless = probe.id === "headless";
	return applyNetworkPolicy(
		klass,
		args.prefs ?? DEFAULT_NETWORK_POLICY_PREFERENCES,
		args.estimatedBytes,
		{ now: args.now, isHeadless },
	);
}

/** Surface for tests: full snapshot of the raw probe result + decision. */
export async function describeRuntimeNetwork(args?: {
	prefs?: NetworkPolicyPreferences;
	estimatedBytes?: number;
	probe?: NetworkProbe;
	now?: Date;
}): Promise<{
	probeId: NetworkProbe["id"];
	state: RawNetworkState;
	class: NetworkClass;
	decision: NetworkPolicyDecision;
}> {
	const probe = args?.probe ?? pickActiveProbe();
	const state = await probe.probe();
	const klass = classifyNetwork(state);
	const estimatedBytes = args?.estimatedBytes ?? 0;
	const isHeadless = probe.id === "headless";
	const decision = applyNetworkPolicy(
		klass,
		args?.prefs ?? DEFAULT_NETWORK_POLICY_PREFERENCES,
		estimatedBytes,
		{ now: args?.now, isHeadless },
	);
	return { probeId: probe.id, state, class: klass, decision };
}
