import { useSystemProvider } from "../../providers/context";

export function WifiIndicator() {
  const { wifi } = useSystemProvider();
  const label = wifi.connected ? (wifi.ssid ?? "Connected") : "Offline";
  const glyph = wifi.connected ? "\u{1F4F6}" : "\u{1F6AB}";
  return (
    <span
      className="elizaos-shell-indicator elizaos-shell-wifi"
      role="img"
      aria-label={`Wi-Fi: ${label}`}
      title={label}
    >
      {glyph}
    </span>
  );
}
