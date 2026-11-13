import { mobileAppAuthClientsRepository } from "@elizaos/cloud-shared/db/repositories/mobile-app-auth-clients";
import { isAllowedOrigin } from "@elizaos/cloud-shared/lib/security/origin-validation";
import { appsService } from "@elizaos/cloud-shared/lib/services/apps";
import {
  MOBILE_APP_AUTH_CREDENTIAL_TTL_SECONDS,
  MOBILE_APP_AUTH_SCOPES,
  MobileAppAuthProtocolError,
  type MobileAppAuthRegistration,
} from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";

export async function requireRegisteredMobileApp(
  c: AppContext,
  clientId: string,
) {
  if (c.env?.ELIZA_MOBILE_APP_AUTH_ENABLED === "false") {
    throw new MobileAppAuthProtocolError(
      "server_configuration_error",
      "Mobile App Auth is disabled for this environment",
    );
  }

  // 1. Try resolving from database
  const record =
    await mobileAppAuthClientsRepository.findRegisteredMobileClient(clientId);
  if (record) {
    if (!record.client.enabled) {
      throw new MobileAppAuthProtocolError(
        "invalid_client",
        "Unknown or disabled mobile App Auth client",
      );
    }
    if (!record.app.is_active || !record.app.is_approved) {
      throw new MobileAppAuthProtocolError(
        "server_configuration_error",
        "Configured mobile App Auth app is not active and approved",
      );
    }
    const environment =
      c.env?.ENVIRONMENT === "staging" ? "staging" : "production";
    const registration: MobileAppAuthRegistration = {
      appId: record.app.id,
      clientId: record.client.client_id,
      environment,
      redirectUri: record.client.redirect_uri,
      scopes: MOBILE_APP_AUTH_SCOPES,
      credentialTtlSeconds:
        record.client.credential_ttl_seconds ??
        MOBILE_APP_AUTH_CREDENTIAL_TTL_SECONDS,
    };
    const allowedOrigins = await appsService.getAllowedOrigins(record.app);
    if (!isAllowedOrigin(allowedOrigins, registration.redirectUri)) {
      throw new MobileAppAuthProtocolError(
        "server_configuration_error",
        "Configured mobile App Auth app does not allow the registered redirect",
      );
    }
    return { app: record.app, registration };
  }

  throw new MobileAppAuthProtocolError(
    "invalid_client",
    "Unknown or disabled mobile App Auth client",
  );
}
