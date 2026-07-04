/** Barrel for the TRUST action: the umbrella `trustAction`, its per-subaction handlers, and the `hasTrustEngine` availability guard. */

export { evaluateTrustHandler } from "./evaluateTrust.ts";
export { hasTrustEngine } from "./hasTrustEngine.ts";
export { recordTrustInteractionHandler } from "./recordTrustInteraction.ts";
export { requestElevationHandler } from "./requestElevation.ts";
export { updateRoleHandler } from "./roles.ts";
export { trustAction } from "./trust.ts";
