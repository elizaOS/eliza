export const LIFEOPS_CONNECTOR_DEGRADATION_AXES = [
  "missing-scope",
  "rate-limited",
  "disconnected",
  "auth-expired",
  "session-revoked",
  "delivery-degraded",
  "helper-disconnected",
  "retry-idempotent",
  "hold-expired",
  "transport-offline",
  "blocked-resume",
] as const;

export type LifeOpsConnectorDegradationAxis =
  (typeof LIFEOPS_CONNECTOR_DEGRADATION_AXES)[number];

export interface LifeOpsConnectorDegradation {
  axis: LifeOpsConnectorDegradationAxis;
  code: string;
  message: string;
  retryable: boolean;
}
