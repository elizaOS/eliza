/**
 * Autonomy module for elizaOS
 *
 * Provides autonomous operation capabilities for agents.
 */

// Action
export { sendToAdminAction } from "./action";
// Providers
export { adminChatProvider, autonomyStatusProvider } from "./providers";
// Routes
export { autonomyRoutes } from "./routes";
// Service
export {
	AUTONOMY_SERVICE_TYPE,
	AUTONOMY_TASK_NAME,
	AUTONOMY_TASK_TAGS,
	AutonomyService,
} from "./service";
// Types
export type { AutonomyConfig, AutonomyStatus } from "./types";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { sendToAdminAction as _bs_1_sendToAdminAction } from "./action";
import {
	adminChatProvider as _bs_2_adminChatProvider,
	autonomyStatusProvider as _bs_3_autonomyStatusProvider,
} from "./providers";
import { autonomyRoutes as _bs_4_autonomyRoutes } from "./routes";
import {
	AUTONOMY_SERVICE_TYPE as _bs_5_AUTONOMY_SERVICE_TYPE,
	AUTONOMY_TASK_NAME as _bs_6_AUTONOMY_TASK_NAME,
	AUTONOMY_TASK_TAGS as _bs_7_AUTONOMY_TASK_TAGS,
	AutonomyService as _bs_8_AutonomyService,
} from "./service";

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
const __bundle_safety_FEATURES_AUTONOMY_INDEX__ = [
	_bs_1_sendToAdminAction,
	_bs_2_adminChatProvider,
	_bs_3_autonomyStatusProvider,
	_bs_4_autonomyRoutes,
	_bs_5_AUTONOMY_SERVICE_TYPE,
	_bs_6_AUTONOMY_TASK_NAME,
	_bs_7_AUTONOMY_TASK_TAGS,
	_bs_8_AutonomyService,
];
(
	globalThis as Record<string, unknown>
).__bundle_safety_FEATURES_AUTONOMY_INDEX__ =
	__bundle_safety_FEATURES_AUTONOMY_INDEX__;
