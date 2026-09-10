/** Configures the canonical Cloud hash router for Discord gateway traffic. */

import {
  createHashRouter,
  readServiceAccountCaCert,
  readServiceAccountToken,
} from "@elizaos/cloud-services-common";
import HashRing from "hashring";
import { logger } from "./logger";

const router = createHashRouter({
  createRing: (podIPs) =>
    new HashRing(podIPs, "md5", { "max cache size": 1000 }),
  readServiceAccountToken: () => readServiceAccountToken(),
  readServiceAccountCaCert: () => readServiceAccountCaCert(),
  logger,
});

export const getHashTargets = router.getTargets;
export const refreshHashRing = router.refresh;
