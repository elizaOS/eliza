export type PermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "not-applicable";

export interface PermissionState {
  id: "website-blocking";
  status: PermissionStatus;
  lastChecked: number;
  canRequest: boolean;
  reason?: string;
}
