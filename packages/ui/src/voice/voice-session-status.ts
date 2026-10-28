/** Continuous voice state shared by browser transports and the app UI. */
export type VoiceContinuousStatus =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupting"
  | "transcribing";
