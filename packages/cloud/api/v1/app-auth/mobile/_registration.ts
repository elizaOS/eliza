/** All mobile entry points share the same primary-backed admission policy. */
import { mobileAppAuthClientsRepository } from "@elizaos/cloud-shared/db/repositories/mobile-app-auth-clients";
import {
  admitMobileAppAuthRegistration,
  MobileAppAuthProtocolError,
} from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";

export async function requireRegisteredMobileApp(
  c: AppContext,
  clientId: string,
) {
  const record =
    await mobileAppAuthClientsRepository.findRegisteredMobileClient(clientId);
  const registration = await admitMobileAppAuthRegistration(c.env, record);
  if (!record)
    throw new MobileAppAuthProtocolError(
      "invalid_client",
      "Unknown mobile App Auth client",
    );
  return { app: record.app, registration };
}
