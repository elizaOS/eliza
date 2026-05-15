import { useSystemProvider } from "../../providers/context";

export function AudioIndicator() {
  const { audio, controls } = useSystemProvider();
  const percent = Math.round(audio.level * 100);
  const glyph = audio.muted ? "\u{1F507}" : "\u{1F50A}";
  const label = audio.muted ? "Audio muted" : `Audio ${percent}%`;
  return (
    <button
      type="button"
      className="elizaos-shell-indicator elizaos-shell-audio"
      aria-label={label}
      title={label}
      onClick={() => controls.setAudioMuted(!audio.muted)}
    >
      <span aria-hidden="true">{glyph}</span>
      <span className="elizaos-shell-audio-pct">{percent}%</span>
    </button>
  );
}
