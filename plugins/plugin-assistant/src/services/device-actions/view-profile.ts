import {
  DEVICE_VIEWS,
  DeviceActionError,
  exactKeys,
  object,
} from "./contract.ts";
export interface DeviceViewProfile {
  version: 1;
  revision: string;
  views: readonly string[];
}
export function enabledDeviceViews(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > DEVICE_VIEWS.length ||
    value.some(
      (v) =>
        typeof v !== "string" ||
        !(DEVICE_VIEWS as readonly string[]).includes(v),
    ) ||
    new Set(value).size !== value.length
  )
    throw new DeviceActionError("Invalid enabled views");
  return [...value].sort();
}
export function storedDeviceViewProfile(
  value: unknown,
): DeviceViewProfile | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 2048)
    throw new DeviceActionError("View profile unavailable");
  let row: Record<string, unknown>;
  try {
    row = object(JSON.parse(value));
  } catch {
    throw new DeviceActionError("View profile unavailable");
  }
  exactKeys(row, ["version", "revision", "views"]);
  if (
    row.version !== 1 ||
    typeof row.revision !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      row.revision,
    )
  )
    throw new DeviceActionError("View profile unavailable");
  return {
    version: 1,
    revision: row.revision,
    views: enabledDeviceViews(row.views),
  };
}
