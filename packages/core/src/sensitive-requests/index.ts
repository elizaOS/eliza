/**
 * Sensitive-request channel-adapter dispatch registry.
 *
 * Public surface:
 * - `createSensitiveRequestDispatchRegistry()` — factory.
 * - `SensitiveRequestDispatchRegistry` — registry interface.
 * - `SensitiveRequestDeliveryAdapter` — adapter contract.
 * - `DeliveryTarget`, `DeliveryResult`, `DispatchSensitiveRequest`,
 *   `SensitiveRequestWithPaymentContext`, `SensitiveRequestPaymentContextDescriptor`.
 *
 * The full persistence record (with epoch-ms timestamps and unified
 * payment-context shape) lands in Wave B. The legacy `SensitiveRequest`
 * exported from `sensitive-request-policy.ts` remains the request-creation
 * shape until then.
 */

export {
	createSensitiveRequestDispatchRegistry,
	type DeliveryResult,
	type DeliveryTarget,
	type DispatchSensitiveRequest,
	type SensitiveRequestDeliveryAdapter,
	type SensitiveRequestDispatchRegistry,
	type SensitiveRequestPaymentContextDescriptor,
	type SensitiveRequestWithPaymentContext,
} from "./dispatch-registry";
