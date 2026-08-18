/** Exposes the managed-provider fake upstream and adapter conformance runner. */

export type {
  ProviderAdapterConformanceOptions,
  ProviderAdapterConformanceReport,
} from "./conformance.js";
export {
  assertCompleteScenarioCatalog,
  PROVIDER_CONTRACT_REPORT_NONCE_ENV,
  PROVIDER_CONTRACT_REPORT_PATH_ENV,
  requiredProviderContractScenarios,
  runProviderAdapterConformance,
} from "./conformance.js";
export type {
  FakeProviderOptions,
  FakeWebhookEvent,
  RunningFakeProvider,
} from "./fake-provider.js";
export {
  redactProviderDiagnostics,
  startFakeProvider,
} from "./fake-provider.js";
export type {
  ProviderActionReceipt,
  ProviderContractCapability,
  ProviderContractObservation,
  ProviderContractScenario,
  ProviderProtocolFault,
  ProviderProtocolFixture,
  RecordedProviderRequest,
} from "./types.js";
export { PROVIDER_CONTRACT_SCENARIOS } from "./types.js";
