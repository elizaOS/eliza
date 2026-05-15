import { useSystemProvider } from "../../providers/context";

export function BatteryIndicator() {
  const { battery } = useSystemProvider();
  const glyph = battery.charging ? "\u{26A1}" : "\u{1F50B}";
  const label = `Battery ${battery.percent}%${battery.charging ? " charging" : ""}`;
  return (
    <span
      className="elizaos-shell-indicator elizaos-shell-battery"
      role="img"
      aria-label={label}
      title={label}
    >
      <span aria-hidden="true">{glyph}</span>
      <span className="elizaos-shell-battery-pct">{battery.percent}%</span>
    </span>
  );
}
