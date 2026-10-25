/** Preserves independent chat and embedding adapter ownership for the device relay. */
import {
  CapacitorLlamaAdapter,
  capacitorLlama,
} from "./capacitor-llama-adapter.js";
import type { LlamaAdapter } from "./definitions.js";

let embeddingAdapter: LlamaAdapter | null = null;
export function loadCapacitorLlama(
  role: "chat" | "embedding" = "chat",
): LlamaAdapter {
  if (role === "chat") return capacitorLlama;
  embeddingAdapter ??= new CapacitorLlamaAdapter();
  return embeddingAdapter;
}
