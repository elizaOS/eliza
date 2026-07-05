/**
 * Returns true when the agent is running on a platform that prohibits dynamic
 * code loading (iOS App Store and Google Play builds).
 */
import { resolvePlatform } from "@elizaos/shared";

export function isRestrictedPlatform(): boolean {
	const variant = (process.env.ELIZA_BUILD_VARIANT ?? "").trim().toLowerCase();
	if (variant === "store") return true;
	const platform = resolvePlatform() ?? "";
	return platform === "ios" || platform === "android";
}
