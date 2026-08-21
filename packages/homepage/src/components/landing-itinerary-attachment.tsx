import {
  CloudRain,
  KeyRound,
  Luggage,
  MapPin,
  Plane,
  Utensils,
} from "lucide-react";
import type { LandingDemoItinerary } from "@/lib/landing-demo";

const STOP_ICONS = [Plane, Luggage, Utensils, KeyRound] as const;

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
        <span>
          <strong>{itinerary.title}</strong>
          <small>
            <CloudRain aria-hidden="true" />
            {itinerary.alert}
          </small>
        </span>
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
                <small>{stop.detail}</small>
              </span>
            </li>
          );
        })}
      </ol>
    </article>
  );
}
