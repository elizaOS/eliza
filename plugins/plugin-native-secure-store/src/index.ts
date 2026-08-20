import { registerPlugin } from "@capacitor/core";
import type { ElizaSecureStorePlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () =>
  import("./web").then((module) => new module.ElizaSecureStoreWeb());

export const ElizaSecureStore = registerPlugin<ElizaSecureStorePlugin>(
  "ElizaSecureStore",
  { web: loadWeb },
);
