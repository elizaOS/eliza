import { ArrowRight, Backpack, CalendarDays, Car, MapPin } from "lucide-react";
import type { LandingDemoHandoff } from "@/lib/landing-demo";

export function LandingHandoffAttachment({
  handoff,
}: {
  handoff: LandingDemoHandoff;
}) {
  return (
    <article
      className="landing-handoff-attachment"
      aria-label={`${handoff.child} ${handoff.title}, ${handoff.day} at ${handoff.time}, ${handoff.location}, ${handoff.handoff.replace("→", "to")}, ${handoff.notes.join(", ")}`}
    >
      <header className="landing-handoff-head">
        <span className="landing-handoff-date" aria-hidden="true">
          <small>{handoff.day.slice(0, 3)}</small>
          <strong>{handoff.time.replace(" PM", "")}</strong>
        </span>
        <span className="landing-handoff-title">
          <strong>{`${handoff.child} · ${handoff.title}`}</strong>
          <small>{`${handoff.day} at ${handoff.time}`}</small>
        </span>
        <CalendarDays aria-hidden="true" />
      </header>
      <div className="landing-handoff-location">
        <MapPin aria-hidden="true" />
        <span>{handoff.location}</span>
      </div>
      <div className="landing-handoff-transfer">
        <strong>{handoff.handoff.split(" → ")[0]}</strong>
        <ArrowRight aria-hidden="true" />
        <strong>{handoff.handoff.split(" → ")[1]}</strong>
      </div>
      <ul className="landing-handoff-notes">
        {handoff.notes.map((note, index) => (
          <li key={note}>
            {index === 0 ? (
              <Backpack aria-hidden="true" />
            ) : (
              <Car aria-hidden="true" />
            )}
            <span>{note}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}
