declare module "@elizaos/capacitor-appblocker" {
  export type {
    AppBlockerPermissionResult,
    AppBlockerPermissionStatus,
    AppBlockerPlugin,
    AppBlockerStatus,
    BlockAppsOptions,
    BlockAppsResult,
    InstalledApp,
    SelectAppsResult,
    UnblockAppsResult,
  } from "../../../native-plugins/appblocker/src/definitions";
  export { AppBlocker } from "../../../native-plugins/appblocker/src/index";
}

declare module "@elizaos/capacitor-camera" {
  export * from "../../../native-plugins/camera/src/index";
}

declare module "@elizaos/capacitor-canvas" {
  export * from "../../../native-plugins/canvas/src/index";
}

declare module "@elizaos/capacitor-contacts" {
  export type {
    ContactSummary,
    ContactsPlugin,
    CreateContactOptions,
    ImportedContactSummary,
    ImportVCardOptions,
    ListContactsOptions,
  } from "../../../native-plugins/contacts/src/definitions";
  export { Contacts } from "../../../native-plugins/contacts/src/index";
}

declare module "@elizaos/capacitor-gateway" {
  export * from "../../../native-plugins/gateway/src/index";
}

declare module "@elizaos/capacitor-location" {
  export * from "../../../native-plugins/location/src/index";
}

declare module "@elizaos/capacitor-messages" {
  export * from "../../../native-plugins/messages/src/index";
}

declare module "@elizaos/capacitor-mobile-signals" {
  export type {
    MobileSignalsHealthSnapshot,
    MobileSignalsPermissionStatus,
    MobileSignalsSetupAction,
    MobileSignalsSignal,
    MobileSignalsSnapshot,
  } from "../../../native-plugins/mobile-signals/src/definitions";
  export { MobileSignals } from "../../../native-plugins/mobile-signals/src/index";
}

declare module "@elizaos/capacitor-phone" {
  export type {
    CallLogEntry,
    CallLogType,
    ListRecentCallsOptions,
    PhonePlugin,
    PhoneStatus,
    PlaceCallOptions,
    SaveCallTranscriptOptions,
  } from "../../../native-plugins/phone/src/definitions";
  export { Phone } from "../../../native-plugins/phone/src/index";
}

declare module "@elizaos/capacitor-wifi" {
  export type {
    ConnectedNetworkResult,
    ConnectOptions,
    ConnectResult,
    ListNetworksOptions,
    ListNetworksResult,
    WiFiNetwork,
    WiFiPlugin,
    WifiStateResult,
  } from "../../../native-plugins/wifi/src/definitions";
  export { WiFi } from "../../../native-plugins/wifi/src/index";
}

declare module "@elizaos/capacitor-screencapture" {
  export * from "../../../native-plugins/screencapture/src/index";
}

declare module "@elizaos/capacitor-swabble" {
  export * from "../../../native-plugins/swabble/src/index";
}

declare module "@elizaos/capacitor-system" {
  export * from "../../../native-plugins/system/src/index";
}

declare module "@elizaos/capacitor-talkmode" {
  export * from "../../../native-plugins/talkmode/src/index";
}

declare module "@elizaos/capacitor-websiteblocker" {
  export * from "../../../native-plugins/websiteblocker/src/index";
}
