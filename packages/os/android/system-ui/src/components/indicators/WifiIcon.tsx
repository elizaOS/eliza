import { useSystemProvider } from "../../providers/context";

export function WifiIcon() {
  const { wifi } = useSystemProvider();
  const label = wifi.connected ? (wifi.ssid ?? "Connected") : "Wi-Fi off";
  const glyph = wifi.connected ? "\u{1F4F6}" : "\u{1F4F4}";
  return (
    <span
      className="elizaos-mobile-icon elizaos-mobile-wifi"
      role="img"
      aria-label={`Wi-Fi: ${label}`}
    >
      {glyph}
    </span>
  );
}
