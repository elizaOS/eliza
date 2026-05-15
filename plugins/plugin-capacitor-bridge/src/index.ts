export async function runAndroidBridgeCli(): Promise<void> {
	const { runAndroidBridgeCli } = await import("./android/bridge.js");
	await runAndroidBridgeCli();
}

export async function runIosBridgeCli(argv?: string[]): Promise<void> {
	const { runIosBridgeCli } = await import("./ios/bridge.js");
	await runIosBridgeCli(argv);
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
