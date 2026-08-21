/**
 * Inline maps chat widgets for `[MAPSCARD]` replies: place and place-list
 * result cards, a route summary card, share/navigation handoff cards with
 * per-platform deep links, and the interactive precise-location card that
 * collects device coordinates behind the platform permission prompt.
 *
 * Display cards derive their map links from validated payload coordinates;
 * handoff cards use the action-supplied URIs, which the parser has already
 * restricted to `geo:` / Apple Maps / OpenStreetMap targets. The locate card
 * reads the device position only after an explicit tap, keeps denial and
 * unavailability as visibly distinct error states, and reports coordinates
 * back through the ordinary action-message pipeline (`ctx.sendAction`).
 */

import {
  Check,
  Copy,
  Crosshair,
  Loader2,
  MapPin,
  Navigation,
  Route,
} from "lucide-react";
import { useCallback, useState } from "react";
import { getFrontendPlatform } from "../../../platform/platform-guards";
import { Button } from "../../ui/button";
import type {
  MapsCardPlace,
  MapsCardSpec,
  MapsTravelMode,
} from "../message-maps-parser";
import type { InlineWidgetContext } from "./inline-registry";

const TRAVEL_MODE_LABELS: Record<MapsTravelMode, string> = {
  drive: "Drive",
  walk: "Walk",
  bicycle: "Bicycle",
  transit: "Transit",
};

export function formatDistance(meters: number): string {
  if (meters < 1_000) return `${Math.round(meters)} m`;
  const km = meters / 1_000;
  return `${km >= 100 ? Math.round(km) : Math.round(km * 10) / 10} km`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Deterministic UTC display of an ISO share timestamp (no locale APIs). */
export function formatSharedAt(sharedAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(sharedAt);
  return match ? `${match[1]} ${match[2]} UTC` : sharedAt;
}

/** The map link this device's platform opens most natively. */
export function preferredMapUri(uris: {
  geoUri: string;
  appleMapsUri: string;
  webUri: string;
}): string {
  const platform = getFrontendPlatform();
  if (platform === "ios") return uris.appleMapsUri;
  if (platform === "android") return uris.geoUri;
  return uris.webUri;
}

function placeMapUris(place: MapsCardPlace): {
  geoUri: string;
  appleMapsUri: string;
  webUri: string;
} {
  const point = `${place.latitude},${place.longitude}`;
  const label = encodeURIComponent(place.name);
  return {
    geoUri: `geo:${point}?q=${point}(${label})`,
    appleMapsUri: `https://maps.apple.com/?ll=${point}&q=${label}`,
    webUri: `https://www.openstreetmap.org/?mlat=${place.latitude}&mlon=${place.longitude}#map=17/${place.latitude}/${place.longitude}`,
  };
}

/** Adapter-owned legal attribution text; renders nothing when the provider
 * carries none rather than fabricating a placeholder. */
function AttributionLine({ attribution }: { attribution: string | null }) {
  if (!attribution) return null;
  return (
    <div
      className="pt-0.5 text-3xs text-muted"
      data-testid="maps-attribution"
    >
      {attribution}
    </div>
  );
}

function PlaceRow({
  place,
  ctx,
  compact,
}: {
  place: MapsCardPlace;
  ctx: InlineWidgetContext;
  compact?: boolean;
}) {
  const uris = placeMapUris(place);
  return (
    <div className="flex min-w-0 items-start gap-2 py-1">
      <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{place.name}</div>
        {place.formattedAddress ? (
          <div className="truncate text-xs text-muted">
            {place.formattedAddress}
          </div>
        ) : (
          <div className="truncate text-xs text-muted">
            {place.latitude}, {place.longitude}
          </div>
        )}
        {!compact && place.categories.length > 0 ? (
          <div className="mt-0.5 truncate text-3xs uppercase tracking-wider text-muted">
            {place.categories.join(" · ")}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs"
          data-testid={`maps-directions-${place.providerPlaceId}`}
          onClick={() =>
            ctx.sendAction(
              `Get directions to ${place.name} (${place.provider} place ${place.providerPlaceId})`,
            )
          }
        >
          <Route className="h-3.5 w-3.5" aria-hidden />
          Directions
        </Button>
        <a
          href={preferredMapUri(uris)}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-accent underline-offset-2 hover:underline"
          data-testid={`maps-open-${place.providerPlaceId}`}
        >
          Map
        </a>
      </div>
    </div>
  );
}

type LocateStatus = "idle" | "locating" | "sent" | "denied" | "unavailable";

function LocateCard({
  prompt,
  ctx,
}: {
  prompt: string;
  ctx: InlineWidgetContext;
}) {
  const [status, setStatus] = useState<LocateStatus>("idle");

  const locate = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("unavailable");
      return;
    }
    setStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        ctx.sendAction(
          `My current location is latitude ${latitude}, longitude ${longitude} (precise device location).`,
        );
        setStatus("sent");
      },
      (error) => {
        // error-policy:J4 geolocation denial/failure becomes a visibly
        // distinct card state; PERMISSION_DENIED (1) is denied, the rest
        // (position unavailable / timeout) are unavailable.
        setStatus(error.code === 1 ? "denied" : "unavailable");
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }, [ctx]);

  return (
    <div className="my-2 space-y-2 text-sm" data-testid="maps-locate">
      <div className="flex items-center gap-2">
        <Crosshair className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1">{prompt}</span>
      </div>
      {status === "idle" ? (
        <Button
          type="button"
          size="sm"
          data-testid="maps-locate-start"
          onClick={locate}
        >
          <Crosshair className="h-3.5 w-3.5" aria-hidden />
          Share precise location
        </Button>
      ) : null}
      {status === "locating" ? (
        <span
          className="inline-flex items-center gap-1.5 text-xs text-muted"
          data-testid="maps-locate-locating"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Getting your precise location…
        </span>
      ) : null}
      {status === "sent" ? (
        <span
          className="inline-flex items-center gap-1.5 text-xs text-muted"
          data-testid="maps-locate-sent"
        >
          <Check className="h-3.5 w-3.5 text-accent" aria-hidden />
          Location shared with the agent.
        </span>
      ) : null}
      {status === "denied" ? (
        <span className="text-xs text-danger" data-testid="maps-locate-denied">
          Location permission was denied. Allow precise location for this app in
          your system settings, then try again.
        </span>
      ) : null}
      {status === "unavailable" ? (
        <span
          className="text-xs text-danger"
          data-testid="maps-locate-unavailable"
        >
          Your location is unavailable right now. Check that location services
          are on, or type an address instead.
        </span>
      ) : null}
      {status === "denied" || status === "unavailable" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-3 text-xs"
          data-testid="maps-locate-retry"
          onClick={locate}
        >
          Try again
        </Button>
      ) : null}
    </div>
  );
}

function HandoffCard({
  card,
}: {
  card: Extract<MapsCardSpec, { kind: "handoff" }>;
}) {
  const [copied, setCopied] = useState(false);
  const isShare = card.handoffKind === "share";
  const primary = preferredMapUri(card);
  const copy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      return;
    }
    void navigator.clipboard.writeText(card.geoUri).then(() => {
      setCopied(true);
    });
  }, [card.geoUri]);

  return (
    <div className="my-2 space-y-2 text-sm" data-testid="maps-handoff">
      <div className="flex min-w-0 items-center gap-2">
        <Navigation className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">
          {isShare
            ? `Share ${card.place.name}`
            : `Navigate to ${card.place.name}`}
        </span>
      </div>
      {card.place.formattedAddress ? (
        <div className="truncate text-xs text-muted">
          {card.place.formattedAddress}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" data-testid="maps-handoff-open">
          <a href={primary} target="_blank" rel="noreferrer">
            <Navigation className="h-3.5 w-3.5" aria-hidden />
            {isShare ? "Open map" : "Start navigation"}
          </a>
        </Button>
        {isShare ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs"
            data-testid="maps-handoff-copy"
            onClick={copy}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
            {copied ? "Copied" : "Copy link"}
          </Button>
        ) : null}
        <span className="text-xs text-muted">
          <a
            href={card.appleMapsUri}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline"
          >
            Apple Maps
          </a>
          {" · "}
          <a
            href={card.webUri}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline"
          >
            OpenStreetMap
          </a>
        </span>
      </div>
      {isShare && card.sharedAt ? (
        <div
          className="text-3xs uppercase tracking-wider text-muted"
          data-testid="maps-handoff-receipt"
        >
          Shared {formatSharedAt(card.sharedAt)}
        </div>
      ) : null}
    </div>
  );
}

export function MapsCardWidget({
  card,
  ctx,
}: {
  card: MapsCardSpec;
  ctx: InlineWidgetContext;
}) {
  switch (card.kind) {
    case "place":
      return (
        <div className="my-2" data-testid="maps-place">
          <PlaceRow place={card.place} ctx={ctx} />
          <AttributionLine attribution={card.attribution} />
        </div>
      );
    case "places":
      return (
        <div className="my-2" data-testid="maps-places">
          <div className="text-3xs uppercase tracking-wider text-muted">
            Places for “{card.query}”
          </div>
          <div className="divide-y divide-border/50">
            {card.places.map((place) => (
              <PlaceRow
                key={`${place.provider}:${place.providerPlaceId}`}
                place={place}
                ctx={ctx}
                compact
              />
            ))}
          </div>
          {card.nextCursor ? (
            <div className="pt-1 text-xs text-muted" data-testid="maps-more">
              More results are available — ask for the next page.
            </div>
          ) : null}
          <AttributionLine attribution={card.attribution} />
        </div>
      );
    case "route": {
      const uris = placeMapUris(card.destination);
      return (
        <div className="my-2 space-y-1 text-sm" data-testid="maps-route">
          <div className="flex min-w-0 items-center gap-2">
            <Route className="h-4 w-4 shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-medium">
              {card.origin.name} → {card.destination.name}
            </span>
          </div>
          <div className="text-xs text-muted" data-testid="maps-route-summary">
            {TRAVEL_MODE_LABELS[card.travelMode]} ·{" "}
            {formatDistance(card.distanceMeters)} ·{" "}
            {formatDuration(card.durationSeconds)}
          </div>
          {card.warnings.length > 0 ? (
            <ul className="text-xs text-warn" data-testid="maps-route-warnings">
              {card.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <a
            href={preferredMapUri(uris)}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs text-accent underline-offset-2 hover:underline"
            data-testid="maps-route-open"
          >
            Open destination in Maps
          </a>
          <AttributionLine attribution={card.attribution} />
        </div>
      );
    }
    case "handoff":
      return <HandoffCard card={card} />;
    case "locate":
      return <LocateCard prompt={card.prompt} ctx={ctx} />;
    default: {
      const _exhaustive: never = card;
      return _exhaustive;
    }
  }
}
