// Coordinates Discord gateway logger behavior for multi-tenant bot pods.
import { createServiceLogger } from "@elizaos/cloud-services-common";

export const logger = createServiceLogger("gateway-discord");
