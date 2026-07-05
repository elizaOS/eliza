/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("TalkMode volume and mute policy contracts", () => {
  it("documents the cross-platform volume and mute semantics", () => {
    const readme = read("README.md");

    expect(readme).toContain("## Volume and mute policy");
    expect(readme).toContain("AVAudioSession");
    expect(readme).toContain("USAGE_VOICE_COMMUNICATION");
    expect(readme).toContain("Electrobun desktop");
    expect(readme).toContain("SpeechSynthesis");
  });

  it("keeps iOS TalkMode on a voice-chat play-and-record session", () => {
    const source = read("ios/Sources/TalkModePlugin/TalkModePlugin.swift");

    expect(source).toContain("setCategory(.playAndRecord");
    expect(source).toContain("mode: .voiceChat");
    expect(source).toContain(".defaultToSpeaker");
    expect(source).toContain(".allowBluetoothA2DP");
    expect(source).not.toContain("setCategory(.playback");
    expect(source).not.toContain("setCategory(.ambient");
  });

  it("keeps Android TalkMode output on the voice-communication path", () => {
    const source = read(
      "android/src/main/java/ai/eliza/plugins/talkmode/TalkModePlugin.kt",
    );

    expect(source).toContain("AudioAttributes.USAGE_VOICE_COMMUNICATION");
    expect(source).toContain("AudioAttributes.CONTENT_TYPE_SPEECH");
    expect(source).toContain("AudioManager.MODE_IN_COMMUNICATION");
    expect(source).toContain(
      "AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE",
    );
    expect(source).toContain("AudioManager.STREAM_MUSIC");
    expect(source).toContain("AudioManager.STREAM_SYSTEM");
    expect(source).toContain("AudioManager.STREAM_NOTIFICATION");
    expect(source).not.toMatch(/earconStreams[\s\S]*STREAM_VOICE_CALL/);
  });
});
