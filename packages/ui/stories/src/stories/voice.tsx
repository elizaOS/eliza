import {
  type FrequencyAnalyser,
  VoiceWaveform,
  type VoiceWaveformMode,
} from "@ui-src/components/voice/VoiceWaveform.tsx";
import { useMemo, useState } from "react";
import type { StoryDefinition } from "../Story.tsx";

/**
 * Fake analyser with a slow, bass-weighted moving spectrum so the orb visibly
 * pulses in the catalog without a live audio graph. Matches the read-only
 * surface the component consumes (`frequencyBinCount` + `getByteFrequencyData`).
 */
function makeOscillatingAnalyser(): FrequencyAnalyser {
  const bins = 128;
  return {
    frequencyBinCount: bins,
    getByteFrequencyData: (buf: Uint8Array) => {
      const t = Date.now() / 1000;
      for (let i = 0; i < buf.length; i += 1) {
        const f = i / buf.length;
        const wave = Math.sin(t * 4 + f * 8) * 0.5 + 0.5;
        const tilt = 1 - f * 0.6;
        buf[i] = Math.max(0, Math.min(255, Math.round(wave * tilt * 230)));
      }
    },
  };
}

const MODES: VoiceWaveformMode[] = ["idle", "listening", "responding"];

function VoiceOrbDemo() {
  const [mode, setMode] = useState<VoiceWaveformMode>("responding");
  const analyser = useMemo(makeOscillatingAnalyser, []);
  return (
    <div style={{ display: "grid", gap: 12, justifyItems: "center" }}>
      <VoiceWaveform mode={mode} analyser={analyser} size={220} />
      <div style={{ display: "flex", gap: 6 }}>
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            style={{
              background:
                m === mode ? "var(--accent-primary, #ff5800)" : "transparent",
              border: "1px solid var(--border, rgba(255,255,255,0.2))",
              borderRadius: 4,
              color: m === mode ? "#fff" : "inherit",
              cursor: "pointer",
              fontSize: 12,
              padding: "4px 10px",
            }}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  );
}

export const voiceStories: StoryDefinition[] = [
  {
    id: "voice-waveform",
    name: "VoiceWaveform (WebGPU orb)",
    importPath:
      'import { VoiceWaveform } from "@elizaos/ui/components/voice/VoiceWaveform"',
    description:
      "Audio-reactive WebGPU/three.js voice avatar: a noise-displaced iridescent plasma core inside a fresnel glow halo, wrapped in a particle swarm. Toggle the mode to compare idle / listening / responding. Accent follows --accent-rgb per surface.",
    render: () => <VoiceOrbDemo />,
  },
];
