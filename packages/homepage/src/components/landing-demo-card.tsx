/** Shared renderer for the capability cards shown in the homepage demo. */
import type { LandingDemoCard } from "@/lib/landing-demo";

function SourceIcon({
  kind,
}: {
  kind: NonNullable<LandingDemoCard["source"]>["kind"];
}) {
  if (kind === "calendar") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2.2" y="3.4" width="11.6" height="10.2" rx="2" />
        <path d="M5 2v3M11 2v3M2.5 6.5h11" />
      </svg>
    );
  }
  if (kind === "web") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.8" />
        <path d="M2.5 8h11M8 2.2c1.7 1.6 2.6 3.5 2.6 5.8S9.7 12.2 8 13.8C6.3 12.2 5.4 10.3 5.4 8S6.3 3.8 8 2.2Z" />
      </svg>
    );
  }
  if (kind === "memory") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <ellipse cx="8" cy="4" rx="5.3" ry="2.2" />
        <path d="M2.7 4v4c0 1.2 2.4 2.2 5.3 2.2s5.3-1 5.3-2.2V4M2.7 8v4c0 1.2 2.4 2.2 5.3 2.2s5.3-1 5.3-2.2V8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.1 6.5A2.9 2.9 0 0 1 8 3.4a2.9 2.9 0 0 1 2.9 3.1c0 3.1 1.7 3.5 1.7 4.5H3.4c0-1 1.7-1.4 1.7-4.5Z" />
      <path d="M6.5 13a1.7 1.7 0 0 0 3 0" />
    </svg>
  );
}

export function LandingDemoCardBubble({ card }: { card: LandingDemoCard }) {
  return (
    <div className="landing-demo-card" data-capability={card.capability}>
      <span className="landing-demo-card-label">{card.label}</span>
      <strong>{card.title}</strong>
      {card.rows.map((row) => (
        <span className="landing-demo-card-row" key={row}>
          {row}
        </span>
      ))}
      {card.source ? (
        <span
          className="landing-demo-card-source"
          data-demo-source={card.source.kind}
        >
          <SourceIcon kind={card.source.kind} />
          {card.source.label}
        </span>
      ) : null}
      {card.status ? (
        <span
          className="landing-demo-card-status"
          data-status-kind={card.statusKind ?? "confirmed"}
        >
          {card.statusKind === "open" ? (
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="5.3" />
              <path d="M8 5v3.2l2.1 1.25" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m3 8.3 3 3L13 4.7" />
            </svg>
          )}
          {card.status}
        </span>
      ) : null}
    </div>
  );
}
