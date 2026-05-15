import { useMemo } from "react";
import { useSystemProvider } from "../providers/context";
import { AudioIndicator } from "./indicators/AudioIndicator";
import { BatteryIndicator } from "./indicators/BatteryIndicator";
import { SettingsButton } from "./indicators/SettingsButton";
import { ShutdownMenu } from "./indicators/ShutdownMenu";
import { WifiIndicator } from "./indicators/WifiIndicator";

export function TopBar() {
  const { time } = useSystemProvider();

  const formatted = useMemo(() => {
    const date = new Date(time.now);
    const timeFmt = new Intl.DateTimeFormat(time.locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: time.timeZone,
    }).format(date);
    const dateFmt = new Intl.DateTimeFormat(time.locale, {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: time.timeZone,
    }).format(date);
    return { time: timeFmt, date: dateFmt };
  }, [time.now, time.locale, time.timeZone]);

  return (
    <header className="elizaos-shell-topbar" role="banner">
      <div className="elizaos-shell-topbar-left">
        <span className="elizaos-shell-clock" aria-label={`Time ${formatted.time}`}>
          {formatted.time}
        </span>
        <span className="elizaos-shell-date" aria-label={formatted.date}>
          {formatted.date}
        </span>
      </div>
      <div className="elizaos-shell-topbar-right" role="toolbar" aria-label="System indicators">
        <WifiIndicator />
        <AudioIndicator />
        <BatteryIndicator />
        <ShutdownMenu />
        <SettingsButton />
      </div>
    </header>
  );
}
