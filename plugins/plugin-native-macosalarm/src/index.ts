/** Barrel for the macosalarm plugin: actions, the Swift-helper IPC layer, the plugin factory, and shared IPC/action types. Default export is the `macosAlarmPlugin` singleton. */

export * from "./actions";
export * from "./helper";
export * from "./plugin";
export { macosAlarmPlugin as default } from "./plugin";
export * from "./types";
