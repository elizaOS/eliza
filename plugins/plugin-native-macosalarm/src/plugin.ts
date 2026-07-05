/**
 * Builds the `macosalarm` elizaOS Plugin: a single ALARM action that schedules,
 * cancels, and lists macOS `UNUserNotificationCenter` alarms through the Swift
 * helper (see `helper.ts`). Declared `"autoEnable": "darwin"` in `package.json`,
 * but the actual non-darwin refusal happens in the action's own `validate()` —
 * this factory is platform-agnostic.
 */

import type { Plugin } from "@elizaos/core";
import { createAlarmAction, type MacosAlarmActionDeps } from "./actions";

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
