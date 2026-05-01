declare module "@elizaos/capacitor-appblocker" {
  export * from "../../../native-plugins/appblocker/src/index";
}

declare module "@elizaos/capacitor-camera" {
  export * from "../../../native-plugins/camera/src/index";
}

declare module "@elizaos/capacitor-canvas" {
  export * from "../../../native-plugins/canvas/src/index";
}

declare module "@elizaos/capacitor-contacts" {
  export { Contacts } from "../../../native-plugins/contacts/src/index";
  export type {
    ContactSummary,
    ListContactsOptions,
    CreateContactOptions,
    ImportVCardOptions,
    ImportedContactSummary,
    ContactsPlugin,
  } from "../../../native-plugins/contacts/src/definitions";
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
  export { MobileSignals } from "../../../native-plugins/mobile-signals/src/index";
  export type {
    MobileSignalsHealthSnapshot,
    MobileSignalsPermissionStatus,
    MobileSignalsSetupAction,
    MobileSignalsSignal,
    MobileSignalsSnapshot,
  } from "../../../native-plugins/mobile-signals/src/definitions";
}

declare module "@elizaos/capacitor-phone" {
  export { Phone } from "../../../native-plugins/phone/src/index";
  export type {
    PlaceCallOptions,
    PhoneStatus,
    CallLogType,
    CallLogEntry,
    ListRecentCallsOptions,
    SaveCallTranscriptOptions,
    PhonePlugin,
  } from "../../../native-plugins/phone/src/definitions";
}

declare module "@elizaos/capacitor-wifi" {
  export { WiFi } from "../../../native-plugins/wifi/src/index";
  export type {
    WiFiNetwork,
    ListNetworksOptions,
    ConnectOptions,
    WifiStateResult,
    ConnectedNetworkResult,
    ListNetworksResult,
    ConnectResult,
    WiFiPlugin,
  } from "../../../native-plugins/wifi/src/definitions";
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
