/**
 * Public entry point for the Capacitor mobile device bridge package.
 *
 * The package exports lazy Android/iOS CLI bootstraps, the runtime service
 * plugin, and filesystem sandbox utilities without starting mobile bridge
 * state during ordinary desktop imports.
 */

export async function runAndroidBridgeCli(): Promise<void> {
	const { runAndroidBridgeCli } = await import("./android/bridge.js");
	await runAndroidBridgeCli();
}

export async function runIosBridgeCli(argv?: string[]): Promise<void> {
	const { runIosBridgeCli } = await import("./ios/bridge.js");
	await runIosBridgeCli(argv);
}

import { mobileDeviceBridgePlugin } from "./mobile-device-bridge-bootstrap.js";

export {
	attachMobileDeviceBridgeToServer,
	CapacitorMobileDeviceBridgeService,
	ensureMobileDeviceBridgeInferenceHandlers,
	getMobileDeviceBridgeStatus,
	loadMobileDeviceBridgeModel,
	type MobileDeviceBridgeStatus,
	mobileDeviceBridge,
	mobileDeviceBridgePlugin,
	unloadMobileDeviceBridgeModel,
} from "./mobile-device-bridge-bootstrap.js";

export default mobileDeviceBridgePlugin;
export {
	getMobileWorkspaceRoot,
	installMobileFsShim,
	isMobileFsShimInstalled,
	sandboxedPath,
} from "./shared/fs-shim.js";
