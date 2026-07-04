// Thin JS wrapper over the native iOS `ElizaKeyboard` Capacitor plugin
// (packages/app-core/platforms/ios/App/App/ElizaKeyboardBridge.swift). The
// app-side dictation session publishes its state through these methods into
// the shared App Group, where the ElizaKeyboard extension polls it and inserts
// the transcript. Returns null off iOS — the handoff only exists there.

import { Capacitor } from "@capacitor/core";

export type KeyboardDictationStatus =
  | "recording"
  | "transcribing"
  | "ready"
  | "error";

export interface KeyboardDictationBridge {
  setDictationState(options: {
    status: KeyboardDictationStatus;
    transcript?: string;
    errorMessage?: string;
    sessionId?: string;
  }): Promise<{ saved: boolean }>;
  clearDictationState(): Promise<{ cleared: boolean }>;
  getDictationState(): Promise<{
    pending: boolean;
    status?: KeyboardDictationStatus;
    transcript?: string;
    errorMessage?: string;
    sessionId?: string;
    updatedAtEpochMs?: number;
  }>;
}

let cached: KeyboardDictationBridge | null = null;

export function getKeyboardDictationBridge(): KeyboardDictationBridge | null {
  if (Capacitor.getPlatform() !== "ios") return null;
  if (!cached) {
    cached = Capacitor.registerPlugin<KeyboardDictationBridge>("ElizaKeyboard");
  }
  return cached;
}
