/**
 * Web fallback for `@elizaos/capacitor-network-policy`.
 *
 * Browsers can read `navigator.connection.saveData` (a heuristic for "user
 * has Data Saver enabled") and `.type` (`cellular` / `wifi` / `ethernet`),
 * but the WICG spec is partial and Firefox/Safari support is limited. The
 * fallback returns conservative defaults so the policy decision falls
 * through to `unknown → ask` — never silently accepts a download on a
 * potentially-metered link.
 */

import { WebPlugin } from "@capacitor/core";

import type {
	MeteredHint,
	NetworkPolicyPlugin,
	PathHints,
} from "./definitions";

export class NetworkPolicyWeb extends WebPlugin implements NetworkPolicyPlugin {
	async getMeteredHint(): Promise<MeteredHint> {
		const saveData = readNavigatorSaveData();
		// `saveData=true` is a strong signal the user wants metered-mode behavior.
		// We don't infer "metered=false" from `saveData=false` — that just means
		// Data Saver isn't on, which says nothing about metering.
		return {
			metered: saveData === true ? true : null,
			source: "android-os",
		};
	}

	async getPathHints(): Promise<PathHints> {
		const saveData = readNavigatorSaveData();
		return {
			isExpensive: saveData === true,
			isConstrained: saveData === true,
			source: "nw-path-monitor",
		};
	}
}

function readNavigatorSaveData(): boolean | null {
	try {
		const nav = globalThis.navigator as
			| { connection?: { saveData?: boolean } }
			| undefined;
		const saveData = nav?.connection?.saveData;
		return typeof saveData === "boolean" ? saveData : null;
	} catch {
		return null;
	}
}
