import type { IAgentRuntime } from "@elizaos/core";
import type { WalletBackend } from "./backend.js";
import { LocalEoaBackend } from "./local-eoa-backend.js";
import { StewardBackend } from "./steward-backend.js";

export type WalletBackendMode = "local" | "steward" | "auto";

function readMode(runtime: IAgentRuntime): WalletBackendMode {
	const raw =
		runtime.getSetting("MILADY_WALLET_BACKEND") ??
		process.env.MILADY_WALLET_BACKEND ??
		"auto";
	if (raw === "local" || raw === "steward" || raw === "auto") {
		return raw;
	}
	return "auto";
}

/**
 * Resolves the active backend. Phase 1 will implement the full desktop/cloud/mobile matrix from the spec;
 * today `auto` always prefers **local** so desktop dev keeps working without Steward.
 */
export async function resolveWalletBackend(
	runtime: IAgentRuntime,
): Promise<WalletBackend> {
	const mode = readMode(runtime);
	if (mode === "steward") {
		return StewardBackend.create(runtime);
	}
	return LocalEoaBackend.create(runtime);
}
