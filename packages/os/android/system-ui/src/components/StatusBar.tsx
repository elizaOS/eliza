import { useMemo } from "react";
import { useSystemProvider } from "../providers/context";
import { AudioIcon } from "./indicators/AudioIcon";
import { BatteryIcon } from "./indicators/BatteryIcon";
import { CellSignal } from "./indicators/CellSignal";
import { WifiIcon } from "./indicators/WifiIcon";

export function StatusBar() {
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
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: time.timeZone,
    }).format(date);
    return { time: timeFmt, date: dateFmt };
  }, [time.now, time.locale, time.timeZone]);

  return (
    <header className="elizaos-mobile-statusbar" role="banner">
      <div className="elizaos-mobile-statusbar-left">
        <span className="elizaos-mobile-clock" aria-label={`Time ${formatted.time}`}>
          {formatted.time}
        </span>
        <span className="elizaos-mobile-date" aria-label={formatted.date}>
          {formatted.date}
        </span>
      </div>
      <div
        className="elizaos-mobile-statusbar-right"
        role="toolbar"
        aria-label="System indicators"
      >
        <WifiIcon />
        <CellSignal />
        <AudioIcon />
        <BatteryIcon />
      </div>
    </header>
  );
}
