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
      <header className="landing-handoff-head">
        <span className="landing-handoff-date" aria-hidden="true">
          <small>{handoff.day.slice(0, 3)}</small>
          <strong>{handoff.time.replace(" PM", "")}</strong>
        </span>
        <span className="landing-handoff-title">
          <strong>{`${handoff.child}'s ${handoff.title.toLowerCase()}`}</strong>
          <span>{handoff.location}</span>
        </span>
      </header>
    </article>
  );
}
