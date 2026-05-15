export { runAndroidBridgeCli } from "./android/bridge.js";
export { runIosBridgeCli } from "./ios/bridge.js";
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
