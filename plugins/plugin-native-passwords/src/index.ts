/** Registers the native password vault proxy and its fail-closed web fallback. */
import { registerPlugin } from "@capacitor/core";
import type { ElizaPasswordsPlugin } from "./definitions";

export * from "./bindings";
export * from "./client";
export * from "./definitions";

const loadWeb = () =>
  import("./web").then((module) => new module.ElizaPasswordsWeb());

export const ElizaPasswords = registerPlugin<ElizaPasswordsPlugin>(
  "ElizaPasswords",
  { web: loadWeb },
);
