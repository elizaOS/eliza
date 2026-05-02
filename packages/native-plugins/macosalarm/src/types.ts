export type MacosAlarmAction = "schedule" | "cancel" | "list" | "permission";

export interface MacosAlarmHelperRequest {
  action: MacosAlarmAction;
  id?: string;
  timeIso?: string;
  title?: string;
  body?: string;
  sound?: string;
}

export interface MacosAlarmHelperScheduleResponse {
  success: true;
  id: string;
  fireAt: string;
}

export interface MacosAlarmHelperCancelResponse {
  success: true;
  id: string;
  cancelled: true;
}

export interface MacosAlarmPendingEntry {
  id: string;
  title: string;
  body: string;
  fireAt?: string;
}

export interface MacosAlarmHelperListResponse {
  success: true;
  alarms: MacosAlarmPendingEntry[];
}

export type MacosAlarmPermissionStatus =
  | "authorized"
  | "provisional"
  | "denied"
  | "not-determined"
  | "ephemeral"
  | "unknown";

export interface MacosAlarmHelperPermissionResponse {
  success: true;
  status: MacosAlarmPermissionStatus;
}

export interface MacosAlarmHelperErrorResponse {
  success: false;
  error: string;
}

export type MacosAlarmHelperResponse =
  | MacosAlarmHelperScheduleResponse
  | MacosAlarmHelperCancelResponse
  | MacosAlarmHelperListResponse
  | MacosAlarmHelperPermissionResponse
  | MacosAlarmHelperErrorResponse;

export interface MacosAlarmActionResult<T> {
  success: boolean;
  reason?: string;
  data?: T;
}

export interface ScheduleAlarmParams {
  timeIso: string;
  title: string;
  body?: string;
  id?: string;
  sound?: string;
}

export interface CancelAlarmParams {
  id: string;
}
