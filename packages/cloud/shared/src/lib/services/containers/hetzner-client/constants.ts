/**
 * Internal constants shared across the Hetzner client sub-modules.
 */

import { containersEnv } from "../../../config/containers-env";

export const DEFAULT_NODE_NETWORK = containersEnv.dockerNetwork();
export const DEFAULT_VOLUME_MOUNT_PATH = "/data";
export const MAX_BOOTSTRAP_FILES = 2000;
export const MAX_BOOTSTRAP_BYTES = 50 * 1024 * 1024;
