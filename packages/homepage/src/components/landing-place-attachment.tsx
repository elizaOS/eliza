import type { LandingDemoPlace } from "@/lib/landing-demo";

export function LandingPlaceAttachment({ place }: { place: LandingDemoPlace }) {
  return (
    <article
      className="landing-place-attachment"
      aria-label={`${place.name}, ${place.neighborhood}, ${place.distance}, ${place.rating} stars`}
    >
      <div className="landing-place-map" aria-hidden="true">
        <svg
          viewBox="0 0 320 132"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path className="landing-map-park" d="M0 0h106l25 38-24 45H0z" />
          <path
            className="landing-map-block"
            d="m190 0 48 0 15 38-52 22-28-25z"
          />
          <path
            className="landing-map-block"
            d="m270 14 50-6v47l-35 4-21-22z"
          />
          <path
            className="landing-map-block"
            d="m146 79 54-20 26 33-18 40h-67z"
          />
          <path className="landing-map-block" d="m239 76 81-9v65h-94z" />
          <path className="landing-map-street" d="M-18 112 337 18" />
          <path className="landing-map-street" d="M121-16 232 149" />
          <path
            className="landing-map-street landing-map-street--minor"
            d="M-14 57 334 111"
          />
          <path
            className="landing-map-street landing-map-street--minor"
            d="M43-12 147 148"
          />
          <path
            className="landing-map-route"
            d="M52 112c42-8 78-25 108-45 23-15 48-22 78-24"
          />
          <circle className="landing-map-user-ring" cx="52" cy="112" r="9" />
          <circle className="landing-map-user" cx="52" cy="112" r="5" />
          <g className="landing-map-pin" transform="translate(229 25)">
            <path d="M18 0C8 0 0 7.6 0 17c0 12.4 18 30 18 30s18-17.6 18-30C36 7.6 28 0 18 0Z" />
            <circle cx="18" cy="17" r="7" />
          </g>
        </svg>
        <span className="landing-place-map-label">{place.name}</span>
      </div>
      <div className="landing-place-copy">
        <div>
          <strong>{place.name}</strong>
          <span>{`${place.category} · ${place.neighborhood}`}</span>
        </div>
        <span className="landing-place-directions" aria-hidden="true">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m13.8 4.4 5.8 5.8a2.6 2.6 0 0 1 0 3.6l-5.8 5.8a2.6 2.6 0 0 1-3.6 0l-5.8-5.8a2.6 2.6 0 0 1 0-3.6l5.8-5.8a2.6 2.6 0 0 1 3.6 0Z" />
            <path d="m9 13 3-3 3 3M12 10v5" />
          </svg>
        </span>
      </div>
      <div className="landing-place-meta">
        <span className="landing-place-rating">
          {place.rating}
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m10 1.8 2.4 5 5.5.8-4 3.8.9 5.4-4.8-2.6L5.2 17l.9-5.5-4-3.8 5.5-.8z" />
          </svg>
        </span>
        <span>{place.distance}</span>
        <span>{place.feature}</span>
      </div>
      <div className="landing-place-fit">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m5.2 10.4 3 3 6.7-7" />
        </svg>
        <span>{place.fit}</span>
      </div>
    </article>
  );
}
