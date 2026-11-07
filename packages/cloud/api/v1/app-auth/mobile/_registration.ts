/** Resolves and verifies the server-owned first-party mobile client record. */
import { appsRepository } from "@elizaos/cloud-shared/db/repositories/apps";
import { isAllowedOrigin } from "@elizaos/cloud-shared/lib/security/origin-validation";
import { appsService } from "@elizaos/cloud-shared/lib/services/apps";
import {
  MobileAppAuthProtocolError,
  resolveMobileAppAuthRegistration,
} from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";

export async function requireRegisteredMobileApp(
  c: AppContext,
  clientId: string,
) {
  const registration = resolveMobileAppAuthRegistration(c.env, clientId);
  const app = await appsRepository.findPublicInfoById(registration.appId);
  if (!app) {
    throw new MobileAppAuthProtocolError(
      "server_configuration_error",
      "Configured mobile App Auth app is not active and approved",
    );
  }
  const allowedOrigins = await appsService.getAllowedOrigins(app);
  if (!isAllowedOrigin(allowedOrigins, registration.redirectUri)) {
    throw new MobileAppAuthProtocolError(
      "server_configuration_error",
      "Configured mobile App Auth app does not allow the registered redirect",
    );
  }
  return { app, registration };
}
