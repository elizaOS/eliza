export type AvatarSpeakingState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking";

export interface AvatarContext {
  audioLevel: () => number;
  speakingState: () => AvatarSpeakingState;
  theme: "sky";
  ownerName?: string;
}

export interface AvatarHandle {
  unmount(): void;
}

export type AvatarKind = "canvas" | "webgl" | "react" | "vrm";

export interface AvatarModule {
  id: string;
  title: string;
  kind: AvatarKind;
  mount(target: HTMLElement, ctx: AvatarContext): AvatarHandle;
}
