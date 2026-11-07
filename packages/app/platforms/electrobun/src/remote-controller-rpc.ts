/** Desktop composition injects the OS secret store into the shared controller. */
import * as controller from "@elizaos/plugin-browser/remote-control/controller";
import type { PlatformSecureStore } from "@elizaos/plugin-browser/remote-control/secure-store-contract";
import { createNodePlatformSecureStore } from "../../../src/security/platform-secure-store-node";

const store = createNodePlatformSecureStore();
export const remoteControllerInternals = controller.remoteControllerInternals;
export function desktopGetOrCreateControllerIdentity(
	params: unknown,
	nativeStore: PlatformSecureStore = store,
) {
	return controller.desktopGetOrCreateControllerIdentity(params, nativeStore);
}
export function desktopCreateRemoteCommand(
	params: unknown,
	nativeStore: PlatformSecureStore = store,
) {
	return controller.desktopCreateRemoteCommand(params, nativeStore);
}
export function desktopAcknowledgeRemoteCommandEnqueue(
	params: unknown,
	nativeStore: PlatformSecureStore = store,
) {
	return controller.desktopAcknowledgeRemoteCommandEnqueue(params, nativeStore);
}
export function desktopClearRemoteSessionState(
	params: unknown,
	nativeStore: PlatformSecureStore = store,
) {
	return controller.desktopClearRemoteSessionState(params, nativeStore);
}
export function desktopOpenRemoteCommandResult(
	params: unknown,
	nativeStore: PlatformSecureStore = store,
) {
	return controller.desktopOpenRemoteCommandResult(params, nativeStore);
}
export function desktopOpenRemoteCommandStartReceipt(
	params: unknown,
	nativeStore: PlatformSecureStore = store,
) {
	return controller.desktopOpenRemoteCommandStartReceipt(params, nativeStore);
}
