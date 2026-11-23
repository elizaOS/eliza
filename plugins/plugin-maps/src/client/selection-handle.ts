/**
 * The phone's opaque handle for its current Maps selection, published as
 * clientDevice `selectedObject.id`. It names an on-screen selection for the
 * approved device read only; it is never a provider place id.
 */
const SELECTION_HANDLE =
  /^maps_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newMapsSelectionHandle(): string {
  return `maps_${crypto.randomUUID()}`;
}

export function isMapsSelectionHandle(value: string): boolean {
  return SELECTION_HANDLE.test(value);
}
