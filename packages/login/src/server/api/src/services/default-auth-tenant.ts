import { runtimeEnvironmentValue } from "../../../shared/src/runtime-env.ts";

/** Resolve the tenant-less auth target from the active request's immutable environment. */
export function defaultAuthTenantId(): string {
  return (
    runtimeEnvironmentValue("STEWARD_DEFAULT_TENANT_ID")?.trim() || "default"
  );
}
