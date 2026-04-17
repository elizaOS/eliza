import { registerPlugin } from "@capacitor/core";

import type { LlamaCapacitorPlugin } from "./definitions";
import { LlamaCapacitorWeb } from "./web";

export * from "./definitions";

export const Llama = registerPlugin<LlamaCapacitorPlugin>("Llama", {
  web: () => Promise.resolve(new LlamaCapacitorWeb()),
});
