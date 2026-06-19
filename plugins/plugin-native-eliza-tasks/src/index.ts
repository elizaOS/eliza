import { registerPlugin } from "@capacitor/core";
import type { ElizaTasksPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.ElizaTasksWeb());

export const ElizaTasks = registerPlugin<ElizaTasksPlugin>("ElizaTasks", {
  web: loadWeb,
});
