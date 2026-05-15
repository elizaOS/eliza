import { useSystemProvider } from "../../providers/context";

export function BatteryIcon() {
  const { battery } = useSystemProvider();
  const glyph = battery.charging ? "\u{26A1}" : "\u{1F50B}";
  const label = `Battery ${battery.percent}%${battery.charging ? " charging" : ""}`;
  return (
    <span
      className="elizaos-mobile-icon elizaos-mobile-battery"
      role="img"
      aria-label={label}
    >
      <span aria-hidden="true">{glyph}</span>
      <span className="elizaos-mobile-battery-pct">{battery.percent}%</span>
    </span>
  );
}
