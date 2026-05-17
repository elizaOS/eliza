/**
 * Cloud Agent Entrypoint (template)
 *
 * Lightweight template variant — no auth, no chat mode, unlimited
 * memories. Shipped inside the cloud-agent-template package for
 * standalone deployment. All logic lives in ../cloud-agent-shared.ts.
 */

import { startCloudAgent } from "../cloud-agent-shared.ts";

startCloudAgent();
