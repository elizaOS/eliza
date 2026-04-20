import type { LlamaAdapter } from "./definitions";

let cachedAdapter: LlamaAdapter | null = null;

export async function loadCapacitorLlama(): Promise<LlamaAdapter> {
  if (cachedAdapter) {
    return cachedAdapter;
  }
  const module = (await import("./index")) as {
    capacitorLlama: LlamaAdapter;
  };
  cachedAdapter = module.capacitorLlama;
  return cachedAdapter;
}
