/** Approved, bounded selected-map read. Opaque targets contain no location data. */
export type MapsTarget = {
  kind: "map-place" | "map-route";
  id: string;
  revision: string;
};
export type MapsOperation = { type: "maps_read_selected"; target: MapsTarget };
type Point = { latitude: number; longitude: number };
export type MapsFields = {
  providerId: string;
  providerRevision: string;
  attribution: string;
} & (
  | { kind: "map-place"; label: string; coordinate: Point }
  | {
      kind: "map-route";
      from: Point;
      to: Point;
      mode: "drive" | "walk" | "bicycle";
      distanceMeters: number;
      durationSeconds: number;
      traffic: "none" | "approximated" | "live";
    }
);
export type MapsResult = {
  kind: "maps_read_selected";
  version: 1;
  target: MapsTarget;
  fields: MapsFields;
};
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("Invalid Maps read");
  return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, allowed: string[]) {
  if (
    Object.keys(v).length !== allowed.length ||
    Object.keys(v).some((k) => !allowed.includes(k))
  )
    throw Error("Invalid Maps read fields");
}
function text(v: unknown, max: number): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in untrusted input.
    /[\u0000-\u001f]/.test(v)
  )
    throw Error("Invalid Maps text");
  return v;
}
function point(v: unknown): Point {
  const p = obj(v);
  keys(p, ["latitude", "longitude"]);
  if (
    typeof p.latitude !== "number" ||
    !Number.isFinite(p.latitude) ||
    typeof p.longitude !== "number" ||
    !Number.isFinite(p.longitude) ||
    Math.abs(p.latitude) > 90 ||
    Math.abs(p.longitude) > 180
  )
    throw Error("Invalid Maps coordinate");
  return { latitude: p.latitude, longitude: p.longitude };
}
export function mapsTarget(v: unknown): MapsTarget {
  const t = obj(v);
  keys(t, ["kind", "id", "revision"]);
  if (
    (t.kind !== "map-place" && t.kind !== "map-route") ||
    !/^maps_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      text(t.id, 64),
    ) ||
    !/^(0|[1-9][0-9]{0,15})$/.test(text(t.revision, 16)) ||
    !Number.isSafeInteger(Number(t.revision))
  )
    throw Error("Invalid Maps target");
  return { kind: t.kind, id: text(t.id, 64), revision: text(t.revision, 16) };
}
export function isMapsOperation(v: { type?: unknown }): v is MapsOperation {
  return v.type === "maps_read_selected";
}
export function validateMapsOperation(v: unknown): MapsOperation {
  const op = obj(v);
  keys(op, ["type", "target"]);
  if (op.type !== "maps_read_selected") throw Error("Invalid Maps operation");
  return { type: op.type, target: mapsTarget(op.target) };
}
export function validateMapsResult(
  op: MapsOperation,
  value: unknown,
): MapsResult {
  const r = obj(value);
  keys(r, ["kind", "version", "target", "fields"]);
  const target = mapsTarget(r.target);
  if (
    r.kind !== op.type ||
    r.version !== 1 ||
    target.id !== op.target.id ||
    target.kind !== op.target.kind ||
    target.revision !== op.target.revision
  )
    throw Error("Maps receipt target changed");
  const f = obj(r.fields),
    common = {
      providerId: text(f.providerId, 80),
      providerRevision: text(f.providerRevision, 128),
      attribution: text(f.attribution, 2000),
    };
  let fields: MapsFields;
  if (target.kind === "map-place") {
    keys(f, [
      "kind",
      "providerId",
      "providerRevision",
      "attribution",
      "label",
      "coordinate",
    ]);
    if (f.kind !== target.kind) throw Error("Maps receipt kind changed");
    fields = {
      ...common,
      kind: "map-place",
      label: text(f.label, 300),
      coordinate: point(f.coordinate),
    };
  } else {
    keys(f, [
      "kind",
      "providerId",
      "providerRevision",
      "attribution",
      "from",
      "to",
      "mode",
      "distanceMeters",
      "durationSeconds",
      "traffic",
    ]);
    if (
      f.kind !== target.kind ||
      (f.mode !== "drive" && f.mode !== "walk" && f.mode !== "bicycle") ||
      (f.traffic !== "none" &&
        f.traffic !== "approximated" &&
        f.traffic !== "live") ||
      typeof f.distanceMeters !== "number" ||
      !Number.isFinite(f.distanceMeters) ||
      f.distanceMeters < 0 ||
      f.distanceMeters > 1e8 ||
      typeof f.durationSeconds !== "number" ||
      !Number.isFinite(f.durationSeconds) ||
      f.durationSeconds < 0 ||
      f.durationSeconds > 1e8
    )
      throw Error("Invalid Maps route receipt");
    fields = {
      ...common,
      kind: "map-route",
      from: point(f.from),
      to: point(f.to),
      mode: f.mode,
      distanceMeters: f.distanceMeters,
      durationSeconds: f.durationSeconds,
      traffic: f.traffic,
    };
  }
  const result: MapsResult = { kind: op.type, version: 1, target, fields };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 7600)
    throw Error("Maps receipt too large");
  return result;
}
