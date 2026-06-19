export type DesktopTrayMode = "collapsed" | "expanded";

export type MicState = "off" | "listening" | "always-on";

export interface TrayMessage {
  id: string;
  role: "agent" | "user";
  text: string;
  createdAt: number;
}

export interface DesktopRuntimeHooks {
  onSend(text: string): void;
  onMicStateChange(next: MicState): void;
  onPushToTalkDown(): void;
  onPushToTalkUp(): void;
  onExpandChange(open: boolean): void;
}
