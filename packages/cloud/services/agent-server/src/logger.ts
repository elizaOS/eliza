// Runs the hosted agent-server logger boundary for cloud runtime containers.
import { createServiceLogger } from "@elizaos/cloud-services-common";

export const logger = createServiceLogger("agent-server", { metaFirst: true });
