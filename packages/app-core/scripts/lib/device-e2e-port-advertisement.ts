/**
 * Publishes a device-e2e host's kernel-assigned port only after synchronizing
 * the child runtime's environment and invalidating port-derived CORS caches.
 */

import { syncResolvedApiPort } from "@elizaos/shared/runtime-env";
import { advertisePort } from "../../../scripts/e2e-ports.mjs";
import { invalidateCorsAllowedPorts } from "../../src/api/server-cors.ts";

export function publishBoundDeviceE2ePort(
  port: number,
  portFile?: string,
): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid bound device-e2e port: ${port}`);
  }

  syncResolvedApiPort(process.env, port, { overwriteUiPort: true });
  invalidateCorsAllowedPorts();

  if (portFile) advertisePort(portFile, port);
}
