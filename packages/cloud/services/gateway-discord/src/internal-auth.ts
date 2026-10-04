import { validateGatewayInternalSecret } from "@elizaos/cloud-services-common/node";
import { logger } from "./logger";

export function validateInternalSecret(request: Request): boolean {
  return validateGatewayInternalSecret(request, logger);
}
