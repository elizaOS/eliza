import { House, Luggage, MapPin, Plane, Utensils } from "lucide-react";
import type { LandingDemoItinerary } from "@/lib/landing-demo";

const STOP_ICONS = [Plane, Luggage, Utensils, House] as const;

export function LandingItineraryAttachment({
  itinerary,
}: {
  itinerary: LandingDemoItinerary;
}) {
  return (
    <article
      className="landing-itinerary-attachment"
      aria-label={`${itinerary.title}: ${itinerary.stops.map((stop) => stop.label).join(", ")}`}
    >
      <header className="landing-itinerary-head">
        <strong>{itinerary.title}</strong>
        <MapPin aria-hidden="true" />
      </header>
      <ol className="landing-itinerary-stops">
        {itinerary.stops.map((stop, index) => {
          const StopIcon = STOP_ICONS[index] ?? MapPin;
          return (
            <li key={`${stop.time}-${stop.label}`}>
              <span className="landing-itinerary-icon" aria-hidden="true">
                <StopIcon />
              </span>
              <span className="landing-itinerary-time">{stop.time}</span>
              <span className="landing-itinerary-copy">
                <strong>{stop.label}</strong>
              </span>
            </li>
          );
        })}
      </ol>
    </article>
  );
}
