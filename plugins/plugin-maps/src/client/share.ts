import { type Coordinate, coordinate, type Route } from "./contracts.ts";
export type MapShare = { title: string; text: string; url?: string };
const point = (value: Coordinate) => {
  const p = coordinate(value);
  return `${p.latitude}, ${p.longitude}`;
};
export function placeShare(label: string, value: Coordinate): MapShare {
  const p = coordinate(value);
  const url = `https://www.openstreetmap.org/?mlat=${p.latitude}&mlon=${p.longitude}#map=17/${p.latitude}/${p.longitude}`;
  return { title: label, text: `${label}\n${point(p)}`, url };
}
export function routeShare(label: string, route: Route): MapShare {
  return {
    title: `Route to ${label}`,
    text: [
      `Route to ${label}`,
      `${route.mode}: ${point(route.from)} → ${point(route.to)}`,
      `${route.distanceMeters} m · ${route.durationSeconds} s`,
      ...route.steps.map((step, index) => `${index + 1}. ${step.instruction}`),
      `Traffic: ${route.traffic}`,
      route.attribution,
    ].join("\n"),
  };
}
const cancelled = () => new DOMException("Share cancelled", "AbortError");
/** Share only an explicit immutable selection; cancelled or retired requests never fall through to another transport. */
export async function shareMap(
  data: MapShare,
  signal: AbortSignal,
  fallback: (
    data: MapShare,
    text: string,
    signal: AbortSignal,
  ) => Promise<"closed">,
): Promise<"shared" | "copied" | "closed"> {
  signal.throwIfAborted();
  const wait = <T>(job: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const cancel = () => {
        signal.removeEventListener("abort", cancel);
        reject(cancelled());
      };
      signal.addEventListener("abort", cancel, { once: true });
      job.then(
        (value) => {
          signal.removeEventListener("abort", cancel);
          signal.aborted ? reject(cancelled()) : resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", cancel);
          reject(error);
        },
      );
      if (signal.aborted) cancel();
    });
  if (navigator.share) {
    try {
      await wait(navigator.share(data));
      return "shared";
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      )
        throw cancelled();
    }
  }
  const text = [data.text, data.url].filter(Boolean).join("\n");
  signal.throwIfAborted();
  if (navigator.clipboard?.writeText) {
    try {
      await wait(navigator.clipboard.writeText(text));
      return "copied";
    } catch {
      signal.throwIfAborted();
    }
  }
  return fallback(data, text, signal);
}
