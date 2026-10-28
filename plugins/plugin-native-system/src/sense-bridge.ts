import { registerPlugin } from "@capacitor/core";
import type { SensePlugin } from "./sense";

export * from "./sense";

/** Browser-safe listener bridge; imports no unrelated native system handlers. */
export const Sense = registerPlugin<SensePlugin>("ElizaSense", {
  web: () => import("./sense-web").then((module) => new module.SenseWeb()),
});
