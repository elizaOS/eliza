/** Resolves and verifies the server-owned first-party mobile client record. */
import { appsRepository } from "@/db/repositories/apps";
import { isAllowedOrigin } from "@/lib/security/origin-validation";
import { appsService } from "@/lib/services/apps";
import {
  MobileAppAuthProtocolError,
  resolveMobileAppAuthRegistration,
} from "@/lib/services/mobile-app-auth";
import type { AppContext } from "@/types/cloud-worker-env";

export async function requireRegisteredMobileApp(c: AppContext) {
  const registration = resolveMobileAppAuthRegistration(c.env);
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
