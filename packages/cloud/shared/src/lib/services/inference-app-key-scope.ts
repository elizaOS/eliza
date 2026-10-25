/** Hydrates app-key ownership only while building a combined inference auth decision. */

import { appsRepository } from "../../db/repositories/apps";

/** Return the app owning an API key, or null for an ordinary organization key. */
export async function loadInferenceAppKeyScope(apiKeyId: string): Promise<string | null> {
  return (await appsRepository.findByApiKeyId(apiKeyId))?.id ?? null;
}
