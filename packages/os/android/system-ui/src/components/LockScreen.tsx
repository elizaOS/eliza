import { type ReactNode, useMemo } from "react";
import { useSystemProvider } from "../providers/context";

export interface LockScreenProps {
  companionBar?: ReactNode;
  cloudsModule?: ReactNode;
}

export function LockScreen({ companionBar, cloudsModule }: LockScreenProps) {
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
    <div
      className="elizaos-mobile-lockscreen"
      style={{
        position: "absolute",
        inset: 0,
        background:
          "linear-gradient(180deg, #7fc4ff 0%, #a8d8ff 55%, #d6eaff 100%)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "64px 24px 32px",
      }}
    >
      <div aria-hidden="true" style={{ position: "absolute", inset: 0 }}>
        {cloudsModule ?? null}
      </div>
      <div
        className="elizaos-mobile-lockscreen-clock"
        style={{
          position: "relative",
          textAlign: "center",
          color: "#06131f",
          textShadow: "0 1px 4px rgba(255,255,255,0.4)",
        }}
      >
        <div
          aria-label={`Time ${formatted.time}`}
          style={{
            fontSize: "84px",
            fontWeight: 200,
            lineHeight: 1,
            letterSpacing: "-0.04em",
          }}
        >
          {formatted.time}
        </div>
        <div
          aria-label={formatted.date}
          style={{ marginTop: 8, fontSize: "18px", fontWeight: 500 }}
        >
          {formatted.date}
        </div>
      </div>
      <div
        className="elizaos-mobile-lockscreen-pill-anchor"
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "center",
          width: "100%",
        }}
      >
        {companionBar ?? null}
      </div>
    </div>
  );
}
