import { capacitorLlama } from "./index";
import type { LlamaAdapter } from "./definitions";

let cachedAdapter: LlamaAdapter | null = null;

export async function loadCapacitorLlama(): Promise<LlamaAdapter> {
  if (cachedAdapter) {
    return cachedAdapter;
  }
  cachedAdapter = capacitorLlama;
  return cachedAdapter;
}
