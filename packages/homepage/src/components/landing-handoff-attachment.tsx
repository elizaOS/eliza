import { CalendarDays } from "lucide-react";
import type { LandingDemoHandoff } from "@/lib/landing-demo";

export function LandingHandoffAttachment({
  handoff,
}: {
  handoff: LandingDemoHandoff;
}) {
  return (
    <article
      className="landing-handoff-attachment"
      aria-label={`${handoff.child}'s ${handoff.title}, ${handoff.day} at ${handoff.time}, ${handoff.location}`}
    >
      <header className="landing-calendar-head landing-attachment-head">
        <span
          className="landing-calendar-icon landing-attachment-icon"
          aria-hidden="true"
        >
          <CalendarDays />
        </span>
        <strong>{`${handoff.day} Calendar`}</strong>
      </header>
      <div className="landing-calendar-day-view" aria-hidden="true">
        <span className="landing-calendar-hour landing-calendar-hour--four">
          4 PM
        </span>
        <span className="landing-calendar-hour landing-calendar-hour--five">
          5 PM
        </span>
        <span className="landing-calendar-line landing-calendar-line--four" />
        <span className="landing-calendar-line landing-calendar-line--half" />
        <span className="landing-calendar-line landing-calendar-line--five" />
        <div className="landing-calendar-event">
          <strong>{`${handoff.child}'s ${handoff.title.toLowerCase()}`}</strong>
          <span>{handoff.time}</span>
          <small>{handoff.location}</small>
        </div>
      </div>
    </article>
  );
}
