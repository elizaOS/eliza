export async function runAndroidBridgeCli(): Promise<void> {
	const { runAndroidBridgeCli } = await import("./android/bridge.js");
	return runAndroidBridgeCli();
}

export async function runIosBridgeCli(): Promise<void> {
	const { runIosBridgeCli } = await import("./ios/bridge.js");
	return runIosBridgeCli();
}
export {
	attachMobileDeviceBridgeToServer,
	ensureMobileDeviceBridgeInferenceHandlers,
	getMobileDeviceBridgeStatus,
	loadMobileDeviceBridgeModel,
	type MobileDeviceBridgeStatus,
	mobileDeviceBridge,
	unloadMobileDeviceBridgeModel,
} from "./mobile-device-bridge-bootstrap.js";
export {
	getMobileWorkspaceRoot,
	installMobileFsShim,
	isMobileFsShimInstalled,
	sandboxedPath,
} from "./shared/fs-shim.js";
