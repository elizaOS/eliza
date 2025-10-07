/**
 * Interface representing settings with string key-value pairs.
 */
export interface RuntimeSettings {
  [key: string]: string | undefined;
}

export interface Setting {
  name: string;
  description: string; // Used in chat context when discussing the setting
  usageDescription: string; // Used during settings to guide users
  value: string | boolean | null;
  required: boolean;
  public?: boolean; // If true, shown in public channels
  secret?: boolean; // If true, value is masked and only shown during settings
  validation?: (value: any) => boolean;
  dependsOn?: string[];
  onSetAction?: (value: any) => string;
  visibleIf?: (settings: { [key: string]: Setting }) => boolean;
}

export interface WorldSettings {
  [key: string]: Setting;
}

export interface OnboardingConfig {
  settings: {
    [key: string]: Omit<Setting, 'value'>;
  };
}
