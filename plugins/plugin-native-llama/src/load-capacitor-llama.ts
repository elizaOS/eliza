/** Module-level singleton cache returning the default `capacitorLlama` adapter. */

import { capacitorLlama } from "./capacitor-llama-adapter.js";
import type { LlamaAdapter } from "./definitions.js";

let cachedAdapter: LlamaAdapter | null = null;

export function loadCapacitorLlama(): LlamaAdapter {
  if (cachedAdapter) {
    return cachedAdapter;
  }
  cachedAdapter = capacitorLlama;
  return cachedAdapter;
}
