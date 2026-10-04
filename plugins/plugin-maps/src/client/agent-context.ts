import {
  type MapsFields,
  type MapsOperation,
  type MapsResult,
  validateMapsResult,
} from "./approved-read.ts";
/** Process-local capability for a Maps observation. The identity envelope contains
 * no location data; content stays local behind the explicitly approved resolver. */
export type MapsSelectedObject = Readonly<{
  kind: "map-place" | "map-route" | "map-search";
  id: string;
  revision: string;
}>;
let current: MapsSelectedObject | undefined;
let identity: unknown;
let readCurrent: (() => MapsFields) | undefined;
export function publishMapsSelection(
  kind: MapsSelectedObject["kind"],
  owner: object,
  revision: number,
  read?: () => MapsFields,
): void {
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error("Invalid Maps observation revision.");
  const id =
    current?.kind === kind && identity === owner
      ? current.id
      : `maps_${crypto.randomUUID()}`;
  identity = owner;
  readCurrent = read;
  current = Object.freeze({ kind, id, revision: String(revision) });
}
export function clearMapsSelection(): void {
  current = undefined;
  identity = undefined;
  readCurrent = undefined;
}
export function getMapsSelectedObject(): MapsSelectedObject | undefined {
  return current ? { ...current } : undefined;
}
export function validateMapsSelectedObject(value: {
  kind: string;
  id: string;
  revision?: string;
  accountId?: string;
}): boolean {
  return (
    !!current &&
    value.accountId === undefined &&
    value.kind === current.kind &&
    value.id === current.id &&
    value.revision === current.revision
  );
}

/** Called only by the approved device executor; never by context serialization. */
export function readMapsSelection(operation: MapsOperation): MapsResult {
  if (!validateMapsSelectedObject(operation.target) || !readCurrent)
    throw Error("Selected Maps observation changed or is unavailable.");
  const fields = readCurrent();
  if (!validateMapsSelectedObject(operation.target))
    throw Error("Selected Maps observation changed.");
  return validateMapsResult(operation, {
    kind: operation.type,
    version: 1,
    target: operation.target,
    fields,
  });
}
