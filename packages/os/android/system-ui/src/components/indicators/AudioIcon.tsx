import { useSystemProvider } from "../../providers/context";

export function AudioIcon() {
  const { audio } = useSystemProvider();
  const glyph = audio.muted ? "\u{1F507}" : "\u{1F50A}";
  const label = audio.muted ? "Audio muted" : `Audio ${Math.round(audio.level * 100)}%`;
  return (
    <span
      className="elizaos-mobile-icon elizaos-mobile-audio"
      role="img"
      aria-label={label}
    >
      {glyph}
    </span>
  );
}
