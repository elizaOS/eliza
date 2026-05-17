import { createServiceLogger } from "@elizaos/cloud-services-common";

export const logger = createServiceLogger("agent-server", { metaFirst: true });
