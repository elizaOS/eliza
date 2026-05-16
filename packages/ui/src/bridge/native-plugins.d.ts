import { type PluginListenerHandle } from "@capacitor/core";

type NativePlugin = Record<string, unknown>;
export declare function getNativePlugin<T extends NativePlugin>(
  name: string,
): T;
export interface SwabbleConfig {
  triggers: string[];
  minPostTriggerGap?: number;
  minCommandLength?: number;
  locale?: string;
  sampleRate?: number;
  modelSize?: "tiny" | "base" | "small" | "medium" | "large";
}
export interface SwabbleAudioLevelEvent {
  level: number;
  peak?: number;
}
export interface SwabblePluginLike extends NativePlugin {
  getConfig(): Promise<{
    config: SwabbleConfig | null;
  }>;
  isListening(): Promise<{
    listening: boolean;
  }>;
  updateConfig(options: { config: Partial<SwabbleConfig> }): Promise<void>;
  start(options: { config: SwabbleConfig }): Promise<{
    started: boolean;
  }>;
  stop(): Promise<void>;
  addListener(
    eventName: "audioLevel",
    listenerFunc: (event: SwabbleAudioLevelEvent) => void,
  ): Promise<PluginListenerHandle>;
}
export interface TalkModeTranscriptEvent {
  transcript?: string;
  isFinal?: boolean;
}
export interface TalkModeErrorEvent {
  code?: string;
  message?: string;
}
export interface TalkModeStateEvent {
  state?: string;
}
export interface MobileSignalsSnapshot {
  source: "mobile_device";
  platform: "ios" | "android" | "web";
  state: "active" | "idle" | "background" | "locked" | "sleeping";
  observedAt: number;
  idleState: "active" | "idle" | "locked" | "unknown" | null;
  idleTimeSeconds: number | null;
  onBattery: boolean | null;
  metadata: Record<string, unknown>;
}
export type MobileSignalsSettingsTarget =
  | "app"
  | "health"
  | "healthConnect"
  | "screenTime"
  | "usageAccess"
  | "notification"
  | "batteryOptimization"
  | "localNetwork"
  | "deviceSettings";
export interface MobileSignalsSetupAction {
  id:
    | "health_permissions"
    | "screen_time_authorization"
    | "android_usage_access"
    | "app_settings"
    | "notification_settings"
    | "battery_optimization"
    | "local_network";
  label: string;
  status: "ready" | "needs-action" | "unavailable";
  canRequest: boolean;
  canOpenSettings: boolean;
  settingsTarget: MobileSignalsSettingsTarget | null;
  reason: string | null;
}
export interface MobileSignalsOpenSettingsResult {
  opened: boolean;
  target: MobileSignalsSettingsTarget;
  actualTarget: MobileSignalsSettingsTarget;
  reason: string | null;
}
export type MobileSignalsPermissionTarget =
  | "all"
  | "health"
  | "screenTime"
  | "notifications";
export interface MobileSignalsRequestPermissionsOptions {
  target?: MobileSignalsPermissionTarget;
}
export interface AppleCalendarPermissionStatus {
  calendar: "granted" | "denied" | "prompt" | "restricted";
  canRequest: boolean;
  reason?: string | null;
}
export type PushNotificationPermissionState =
  | "prompt"
  | "prompt-with-rationale"
  | "granted"
  | "denied";
export interface PushNotificationPermissionStatus {
  receive: PushNotificationPermissionState;
}
export interface PushNotificationsPluginLike extends NativePlugin {
  checkPermissions?: () => Promise<PushNotificationPermissionStatus>;
  requestPermissions?: () => Promise<PushNotificationPermissionStatus>;
}
export interface MobileSignalsPermissionStatus {
  status: "granted" | "denied" | "not-determined" | "not-applicable";
  canRequest: boolean;
  reason?: string;
  screenTime: MobileSignalsScreenTimeStatus;
  setupActions: MobileSignalsSetupAction[];
  permissions: {
    sleep: boolean;
    biometrics: boolean;
  };
}
export interface MobileSignalsScreenTimeStatus {
  supported: boolean;
  requirements: {
    entitlements: {
      familyControls: string;
      appAndWebsiteUsage?: string;
    };
    frameworks: string[];
    deviceActivityReportExtension: boolean;
    deviceActivityMonitorExtension: boolean;
    android?: {
      usageStatsPermission: string;
      usageAccessSettingsAction: string;
    };
  };
  entitlements: {
    familyControls: boolean;
    appAndWebsiteUsage?: boolean;
  };
  provisioning: {
    satisfied: boolean;
    inspected: "code-signature" | "not-inspectable";
    reason: string | null;
  };
  authorization: {
    status: "approved" | "denied" | "not-determined" | "unavailable";
    canRequest: boolean;
  };
  reportAvailable: boolean;
  coarseSummaryAvailable: boolean;
  thresholdEventsAvailable: boolean;
  rawUsageExportAvailable: false;
  android?: {
    usageAccessGranted: boolean;
    packageUsageStatsPermissionDeclared: boolean;
    canOpenUsageAccessSettings: boolean;
    foregroundEventsAvailable: boolean;
    totalTimeForegroundMs: number | null;
  };
  reason: string | null;
}
export interface MobileSignalsHealthSnapshot {
  source: "mobile_health";
  platform: "ios" | "android" | "web";
  state: "idle" | "sleeping";
  observedAt: number;
  idleState: "active" | "idle" | "locked" | "unknown" | null;
  idleTimeSeconds: number | null;
  onBattery: boolean | null;
  healthSource: "healthkit" | "health_connect";
  screenTime: MobileSignalsScreenTimeStatus;
  permissions: {
    sleep: boolean;
    biometrics: boolean;
  };
  sleep: {
    available: boolean;
    isSleeping: boolean;
    asleepAt: number | null;
    awakeAt: number | null;
    durationMinutes: number | null;
    stage: string | null;
  };
  biometrics: {
    sampleAt: number | null;
    heartRateBpm: number | null;
    restingHeartRateBpm: number | null;
    heartRateVariabilityMs: number | null;
    respiratoryRate: number | null;
    bloodOxygenPercent: number | null;
  };
  warnings: string[];
  metadata: Record<string, unknown>;
}
export type MobileSignalsSignal =
  | MobileSignalsSnapshot
  | MobileSignalsHealthSnapshot;
export interface MobileSignalsBackgroundRefreshResult {
  scheduled: boolean;
  identifier?: string;
  earliestBeginInSeconds?: number;
  reason?: string;
}
export interface MobileSignalsCancelBackgroundRefreshResult {
  cancelled: boolean;
  reason?: string;
}
export type AppBlockerPermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "not-applicable";
export interface AppBlockerPermissionResult {
  status: AppBlockerPermissionStatus;
  canRequest: boolean;
  reason?: string;
}
export interface InstalledApp {
  packageName: string;
  displayName: string;
  tokenData?: string;
}
export interface SelectAppsResult {
  apps: InstalledApp[];
  cancelled: boolean;
}
export interface BlockAppsOptions {
  appTokens?: string[];
  packageNames?: string[];
  durationMinutes?: number | null;
}
export interface BlockAppsResult {
  success: boolean;
  endsAt: string | null;
  error?: string;
  blockedCount: number;
}
export interface UnblockAppsResult {
  success: boolean;
  error?: string;
}
export interface AppBlockerStatus {
  available: boolean;
  active: boolean;
  platform: string;
  engine: "family-controls" | "usage-stats-overlay" | "none";
  blockedCount: number;
  blockedPackageNames: string[];
  endsAt: string | null;
  permissionStatus: AppBlockerPermissionStatus;
  reason?: string;
}
export interface AppBlockerPluginLike extends NativePlugin {
  checkPermissions(): Promise<AppBlockerPermissionResult>;
  requestPermissions(): Promise<AppBlockerPermissionResult>;
  getInstalledApps(): Promise<{
    apps: InstalledApp[];
  }>;
  selectApps(): Promise<SelectAppsResult>;
  blockApps(options: BlockAppsOptions): Promise<BlockAppsResult>;
  unblockApps(): Promise<UnblockAppsResult>;
  getStatus(): Promise<AppBlockerStatus>;
}
export interface PhonePluginLike extends NativePlugin {
  getStatus(): Promise<{
    hasTelecom: boolean;
    canPlaceCalls: boolean;
    isDefaultDialer: boolean;
    defaultDialerPackage: string | null;
  }>;
  placeCall(options: { number: string }): Promise<void>;
  openDialer(options?: { number?: string }): Promise<void>;
  listRecentCalls(options?: { limit?: number; number?: string }): Promise<{
    calls: CallLogEntry[];
  }>;
  saveCallTranscript(options: {
    callId: string;
    transcript: string;
    summary?: string;
  }): Promise<{
    updatedAt: number;
  }>;
}
export type CallLogType =
  | "incoming"
  | "outgoing"
  | "missed"
  | "voicemail"
  | "rejected"
  | "blocked"
  | "answered_externally"
  | "unknown";
export interface CallLogEntry {
  id: string;
  number: string;
  cachedName: string | null;
  date: number;
  durationSeconds: number;
  type: CallLogType;
  rawType: number;
  isNew: boolean;
  phoneAccountId: string | null;
  geocodedLocation: string | null;
  transcription: string | null;
  voicemailUri: string | null;
  agentTranscript: string | null;
  agentSummary: string | null;
  agentTranscriptUpdatedAt: number | null;
}
export interface ContactSummary {
  id: string;
  lookupKey: string;
  displayName: string;
  phoneNumbers: string[];
  emailAddresses: string[];
  photoUri?: string;
  starred: boolean;
}
export interface ImportedContactSummary extends ContactSummary {
  sourceName: string;
}
export interface ContactsPluginLike extends NativePlugin {
  listContacts(options?: { query?: string; limit?: number }): Promise<{
    contacts: ContactSummary[];
  }>;
  createContact(options: {
    displayName: string;
    phoneNumber?: string;
    phoneNumbers?: string[];
    emailAddress?: string;
    emailAddresses?: string[];
  }): Promise<{
    id: string;
  }>;
  importVCard(options: { vcardText: string }): Promise<{
    imported: ImportedContactSummary[];
  }>;
}
export interface SmsMessageSummary {
  id: string;
  threadId: string;
  address: string;
  body: string;
  date: number;
  type: number;
  read: boolean;
}
export interface SendSmsResult {
  messageId: string;
  messageUri: string;
}
export interface MessagesPluginLike extends NativePlugin {
  sendSms(options: { address: string; body: string }): Promise<SendSmsResult>;
  listMessages(options?: { limit?: number; threadId?: string }): Promise<{
    messages: SmsMessageSummary[];
  }>;
}
export interface AndroidRoleStatus {
  role: "home" | "dialer" | "sms" | "assistant";
  androidRole: string;
  available: boolean;
  held: boolean;
  holders: string[];
}
export interface AndroidRoleRequestResult {
  role: AndroidRoleStatus["role"];
  held: boolean;
  resultCode: number;
}
export interface SystemPluginLike extends NativePlugin {
  getStatus(): Promise<{
    packageName: string;
    roles: AndroidRoleStatus[];
  }>;
  requestRole(options: {
    role: AndroidRoleStatus["role"];
  }): Promise<AndroidRoleRequestResult>;
  openSettings(): Promise<void>;
  openNetworkSettings(): Promise<void>;
}
export interface MobileSignalsPluginLike extends NativePlugin {
  checkPermissions(): Promise<MobileSignalsPermissionStatus>;
  requestPermissions(
    options?: MobileSignalsRequestPermissionsOptions,
  ): Promise<MobileSignalsPermissionStatus>;
  openSettings(options?: {
    target?: MobileSignalsSettingsTarget;
  }): Promise<MobileSignalsOpenSettingsResult>;
  startMonitoring(options?: { emitInitial?: boolean }): Promise<{
    enabled: boolean;
    supported: boolean;
    platform: "ios" | "android" | "web";
    snapshot: MobileSignalsSnapshot | null;
    healthSnapshot: MobileSignalsHealthSnapshot | null;
  }>;
  stopMonitoring(): Promise<{
    stopped: boolean;
  }>;
  getSnapshot(): Promise<{
    supported: boolean;
    snapshot: MobileSignalsSnapshot | null;
    healthSnapshot: MobileSignalsHealthSnapshot | null;
  }>;
  scheduleBackgroundRefresh?: () => Promise<MobileSignalsBackgroundRefreshResult>;
  cancelBackgroundRefresh?: () => Promise<MobileSignalsCancelBackgroundRefreshResult>;
  addListener(
    eventName: "signal",
    listenerFunc: (event: MobileSignalsSignal) => void,
  ): Promise<PluginListenerHandle>;
}
export interface AppleCalendarPluginLike extends NativePlugin {
  checkPermissions?(): Promise<AppleCalendarPermissionStatus>;
  requestPermissions?(): Promise<AppleCalendarPermissionStatus>;
}
export interface TalkModePermissionStatus {
  microphone?: "granted" | "denied" | "prompt";
  speechRecognition?: "granted" | "denied" | "prompt" | "not_supported";
}
export interface WebsiteBlockerPermissionResult {
  status: "granted" | "denied" | "not-determined" | "not-applicable";
  canRequest: boolean;
  reason?: string;
}
export interface AppBlockerInstalledApp {
  packageName: string;
  displayName: string;
  tokenData?: string;
}
export interface AppBlockerStatusResult {
  available: boolean;
  active: boolean;
  platform: string;
  engine: "family-controls" | "usage-stats-overlay" | "none";
  blockedCount: number;
  blockedPackageNames: string[];
  endsAt: string | null;
  permissionStatus: AppBlockerPermissionResult["status"];
  reason?: string;
}
export interface WebsiteBlockerStatusResult {
  available: boolean;
  active: boolean;
  hostsFilePath: string | null;
  endsAt: string | null;
  websites: string[];
  canUnblockEarly: boolean;
  requiresElevation: boolean;
  engine: "hosts-file" | "vpn-dns" | "network-extension" | "content-blocker";
  platform: string;
  supportsElevationPrompt: boolean;
  elevationPromptMethod:
    | "osascript"
    | "pkexec"
    | "powershell-runas"
    | "vpn-consent"
    | "system-settings"
    | null;
  permissionStatus?: "granted" | "denied" | "not-determined" | "not-applicable";
  canRequestPermission?: boolean;
  canOpenSystemSettings?: boolean;
  reason?: string;
}
export interface WebsiteBlockerPluginLike extends NativePlugin {
  getStatus(): Promise<WebsiteBlockerStatusResult>;
  startBlock(options: {
    websites?: string[] | string;
    durationMinutes?: number | string | null;
    text?: string;
  }): Promise<
    | {
        success: true;
        endsAt: string | null;
        request: {
          websites: string[];
          durationMinutes: number | null;
        };
      }
    | {
        success: false;
        error: string;
        status?: {
          active: boolean;
          endsAt: string | null;
          websites: string[];
          requiresElevation: boolean;
        };
      }
  >;
  stopBlock(): Promise<
    | {
        success: true;
        removed: boolean;
        status: {
          active: boolean;
          endsAt: string | null;
          websites: string[];
          canUnblockEarly: boolean;
          requiresElevation: boolean;
        };
      }
    | {
        success: false;
        error: string;
        status?: {
          active: boolean;
          endsAt: string | null;
          websites: string[];
          canUnblockEarly: boolean;
          requiresElevation: boolean;
        };
      }
  >;
  checkPermissions(): Promise<WebsiteBlockerPermissionResult>;
  requestPermissions(): Promise<WebsiteBlockerPermissionResult>;
  openSettings(): Promise<{
    opened: boolean;
  }>;
}
export interface TalkModePluginLike extends NativePlugin {
  addListener(
    eventName: "transcript",
    listenerFunc: (event: TalkModeTranscriptEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "error",
    listenerFunc: (event: TalkModeErrorEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "stateChange",
    listenerFunc: (event: TalkModeStateEvent) => void,
  ): Promise<PluginListenerHandle>;
  checkPermissions(): Promise<TalkModePermissionStatus>;
  requestPermissions(): Promise<TalkModePermissionStatus>;
  start(options?: {
    config?: {
      stt?: {
        engine?: "web";
        modelSize?: "tiny" | "base" | "small" | "medium" | "large";
        language?: string;
        sampleRate?: number;
      };
      silenceWindowMs?: number;
      interruptOnSpeech?: boolean;
    };
  }): Promise<{
    started: boolean;
    error?: string;
  }>;
  stop(): Promise<void>;
}
export type GenericNativePlugin = NativePlugin;
export declare function getGatewayPlugin(): GenericNativePlugin;
export declare function getSwabblePlugin(): SwabblePluginLike;
export declare function getTalkModePlugin(): TalkModePluginLike;
export declare function getMobileSignalsPlugin(): MobileSignalsPluginLike;
export declare function getAppleCalendarPlugin(): AppleCalendarPluginLike;
export declare function getPushNotificationsPlugin(): PushNotificationsPluginLike;
export declare function getAppBlockerPlugin(): AppBlockerPluginLike;
export declare function getCameraPlugin(): GenericNativePlugin;
export declare function getLocationPlugin(): GenericNativePlugin;
export declare function getScreenCapturePlugin(): GenericNativePlugin;
export declare function getCanvasPlugin(): GenericNativePlugin;
export declare function getDesktopPlugin(): GenericNativePlugin;
export declare function getWebsiteBlockerPlugin(): WebsiteBlockerPluginLike;
export declare function getPhonePlugin(): PhonePluginLike;
export declare function getContactsPlugin(): ContactsPluginLike;
export declare function getMessagesPlugin(): MessagesPluginLike;
export declare function getSystemPlugin(): SystemPluginLike;
//# sourceMappingURL=native-plugins.d.ts.map
