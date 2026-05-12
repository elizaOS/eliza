import type { Plugin } from "@elizaos/core";
import { type MacosAlarmActionDeps, createAlarmAction } from "./actions";

export function createMacosAlarmPlugin(
  deps: MacosAlarmActionDeps = {},
): Plugin {
  return {
    name: "macosalarm",
    description:
      "macOS native alarm scheduling via UNUserNotificationCenter. Auto-enabled on darwin only.",
    actions: [createAlarmAction(deps)],
  };
}

export const macosAlarmPlugin: Plugin = createMacosAlarmPlugin();
