/** Barrel for the SDK's payment-rail router: chooses which payment rail (e.g. x402, on-chain) handles a given payment context. */
export type {
  PaymentContext,
  PaymentRail,
  RailConfig,
  RailStatus,
  RoutingDecision,
} from "./PaymentRouter.js";
export { PaymentRouter } from "./PaymentRouter.js";
