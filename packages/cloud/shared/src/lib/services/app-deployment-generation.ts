/** Owns the immutable app-deployment generation stored in app and container metadata. */

import { isValidUUID } from "../utils/validation";

export const APP_DEPLOYMENT_GENERATION_KEY = "deploymentGeneration";

/** Returns a valid persisted deployment generation, or null for legacy/invalid metadata. */
export function deploymentGenerationFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const value = metadata?.[APP_DEPLOYMENT_GENERATION_KEY];
  return typeof value === "string" && isValidUUID(value) ? value : null;
}

/** Preserves unrelated app metadata while binding it to one deployment generation. */
export function metadataForDeploymentGeneration(
  metadata: Record<string, unknown> | null | undefined,
  generation: string,
): Record<string, unknown> {
  if (!isValidUUID(generation)) {
    throw new Error(`Invalid app deployment generation: ${generation}`);
  }
  return { ...(metadata ?? {}), [APP_DEPLOYMENT_GENERATION_KEY]: generation };
}
