/**
 * Web fallback for `@elizaos/capacitor-llama`.
 *
 * On web (Vite dev server, Electrobun renderer) this package resolves to the
 * main adapter but its `load`/`generate` methods reject with a clear
 * "unavailable" error. The standalone node-llama-cpp engine in
 * `@elizaos/app-core` handles desktop inference; this stub only exists so
 * the Capacitor plugin resolution never crashes during web bundling.
 */

export type {
  GenerateOptions,
  GenerateResult,
  HardwareInfo,
  LlamaAdapter,
  LoadOptions,
  SetSpecTypeArgs,
} from "./definitions";
export { capacitorLlama, registerCapacitorLlamaLoader } from "./index";
