/**
 * Capacitor entry point for the ElizaTasks native bridge — registers the
 * plugin and re-exports its type surface (`./definitions`) for consumers.
 * The web implementation is loaded lazily via `loadWeb` since Capacitor
 * only invokes it on platforms lacking the native (iOS) implementation.
 */
import { registerPlugin } from "@capacitor/core";
import type { ElizaTasksPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.ElizaTasksWeb());

export const ElizaTasks = registerPlugin<ElizaTasksPlugin>("ElizaTasks", {
  web: loadWeb,
});
