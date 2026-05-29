import { createWaveformAvatar } from "./presets/waveform-shader";
import { registerAvatar } from "./registry";

export type { AvatarHostProps } from "./AvatarHost";
export { AvatarHost } from "./AvatarHost";
export { createJarvisAvatar } from "./presets/jarvis";
export { createWaveformAvatar } from "./presets/waveform-shader";
export { getActiveAvatar, getAvatar, registerAvatar } from "./registry";
export type {
  AvatarContext,
  AvatarHandle,
  AvatarKind,
  AvatarModule,
  AvatarSpeakingState,
} from "./types";

registerAvatar(createWaveformAvatar());
