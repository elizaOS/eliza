/** Provider settings expose configuration state, never configured secret values. */
import { isObjectRecord } from "@elizaos/core";

export function formatSettingValue(setting: {
  secret?: boolean;
  value?: string | boolean | null;
}): string {
  if (setting.value === null || setting.value === undefined) return "Not set";
  return setting.secret ? "****************" : String(setting.value);
}

/** Preserve ordinary values and nested settings without mutating stored records. */
export function redactSettingsForProvider(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => {
      if (!isObjectRecord(value)) return [key, value];
      if (
        value.secret === true &&
        value.value !== null &&
        value.value !== undefined
      )
        return [key, { ...value, value: "****************" }];
      return [key, redactSettingsForProvider(value)];
    }),
  );
}
