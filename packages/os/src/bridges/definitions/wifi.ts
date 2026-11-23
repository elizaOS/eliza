// spec/os/android/wifi.md, "Story: Find the networks around a device that manages its own Wi-Fi"; spec/os/android/wifi.md, "Story: Join the network I chose through Android's approval"; spec/os/android/wifi.md, "Story: Disconnect, or go to Android's Internet panel"; spec/os/android/wifi.md, "Story: See whether the device is online or behind a sign-in page"

export type WiFiSecurity = "open" | "owe" | "wpa2" | "wpa3" | "eap" | "wep";

export type JoinableWiFiSecurity = Exclude<WiFiSecurity, "eap" | "wep">;

export interface WiFiNetwork {
  ssid: string;
  bssid: string;
  rssi: number;
  frequency: number;
  capabilities: string;
  secured: boolean;
  security?: WiFiSecurity;
}

export interface ListNetworksOptions {
  maxAge?: number;
  limit?: number;
  joinable?: boolean;
  timeout?: number;
}

export interface ConnectOptions {
  ssid: string;
  password?: string;
  hidden?: boolean;
  security?: JoinableWiFiSecurity;
}

export interface WifiStateResult {
  enabled: boolean;
  connected: boolean;
  rssi: number | null;
}

export interface ConnectedNetworkResult {
  network: WiFiNetwork | null;
}

export interface ListNetworksResult {
  networks: WiFiNetwork[];
}

export interface ConnectResult {
  success: boolean;
  message?: string;
}

export interface ConnectivityResult {
  online: boolean;
  validated: boolean;
  captivePortal: boolean;
  ssid: string | null;
}

export interface WiFiCapabilities {
  sdk: number;
  approvedJoin: boolean;
  internetPanel: boolean;
}

export interface WiFiPermissionStatus {
  location: "granted" | "denied" | "prompt" | "prompt-with-rationale";
}

export interface ApprovedJoinResult {
  status:
    | "connected"
    | "captivePortal"
    | "declined"
    | "unverified"
    | "notConnected"
    | "wrongPassword"
    | "savedNetwork";
}

export interface WiFiPlugin {
  checkPermissions(): Promise<WiFiPermissionStatus>;
  requestPermissions(options?: {
    permissions: "location"[];
  }): Promise<WiFiPermissionStatus>;
  getCapabilities(): Promise<WiFiCapabilities>;
  openInternetPanel(): Promise<void>;
  getWifiState(): Promise<WifiStateResult>;
  getConnectedNetwork(): Promise<ConnectedNetworkResult>;
  listAvailableNetworks(
    options?: ListNetworksOptions,
  ): Promise<ListNetworksResult>;
  connectToNetwork(options: ConnectOptions): Promise<ConnectResult>;
  disconnectFromNetwork(): Promise<ConnectResult>;
  getConnectivity(): Promise<ConnectivityResult>;
  addNetworkWithApproval(options: ConnectOptions): Promise<ApprovedJoinResult>;
}
