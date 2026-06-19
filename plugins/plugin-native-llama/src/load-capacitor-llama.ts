import { capacitorLlama } from "./capacitor-llama-adapter";
import type { LlamaAdapter } from "./definitions";

let cachedAdapter: LlamaAdapter | null = null;

export function loadCapacitorLlama(): LlamaAdapter {
  if (cachedAdapter) {
    return cachedAdapter;
  }
  cachedAdapter = capacitorLlama;
  return cachedAdapter;
}
