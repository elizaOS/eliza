/**
 * @module plugin-app-control/services
 * @description Barrel export for plugin services.
 */

export {
	AppVerificationService,
	type CheckResult,
	type VerificationCheck,
	type VerificationCheckKind,
	type VerificationProfile,
	type VerificationResult,
	type VerifyOptions,
} from "./app-verification.js";
export type { Diagnostic, PackageManager } from "./verification-helpers.js";
