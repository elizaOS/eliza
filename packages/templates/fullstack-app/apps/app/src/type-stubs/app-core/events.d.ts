export const AGENT_READY_EVENT: string;
export const APP_PAUSE_EVENT: string;
export const APP_RESUME_EVENT: string;
export const COMMAND_PALETTE_EVENT: string;
export const CONNECT_EVENT: string;
export const SHARE_TARGET_EVENT: string;
export const TRAY_ACTION_EVENT: string;

export function dispatchAppEvent(name: string, detail?: unknown): void;
