import type {
  JsonValue,
  OnboardingConfig as ProtoOnboardingConfig,
  RuntimeSettings as ProtoRuntimeSettings,
  Setting as ProtoSetting,
  SettingDefinition as ProtoSettingDefinition,
  WorldSettings as ProtoWorldSettings,
} from "./proto.js";

/**
 * Runtime settings provided as key/value strings.
 */
export interface RuntimeSettings
  extends Omit<ProtoRuntimeSettings, "$typeName" | "$unknown" | "values"> {
  values?: Record<string, string>;
  [key: string]: JsonValue | undefined;
}

/**
 * Definition metadata for a setting (without value).
 */
export type SettingDefinition = Omit<
  ProtoSettingDefinition,
  "$typeName" | "$unknown"
>;

/**
 * Concrete setting value with runtime-only callbacks.
 */
export interface Setting
  extends Omit<ProtoSetting, "$typeName" | "$unknown" | "value"> {
  value: string | boolean | null;
  public?: boolean;
  secret?: boolean;
  validation?: (value: string | boolean | null) => boolean;
  dependsOn: string[];
  onSetAction?: (value: string | boolean | null) => string;
  visibleIf?: (settings: Record<string, Setting>) => boolean;
}

/**
 * World settings configuration map.
 */
export interface WorldSettings
  extends Omit<ProtoWorldSettings, "$typeName" | "$unknown" | "settings"> {
  settings?: Record<string, Setting>;
  [key: string]: Setting | Record<string, Setting> | undefined;
}

/**
 * Onboarding configuration with setting definitions.
 */
export type OnboardingConfig = Omit<
  ProtoOnboardingConfig,
  "$typeName" | "$unknown"
>;
