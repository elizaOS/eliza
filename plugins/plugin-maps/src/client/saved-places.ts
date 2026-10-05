import {
  boundedText,
  type Coordinate,
  coordinate,
  MapsFailure,
} from "./contracts.ts";

export type SavedPlace = Readonly<{
  id: string;
  label: string;
  coordinate: Coordinate;
  providerId?: string;
  providerPlaceId?: string;
  savedAt: number;
}>;
const LIMIT = 200;
/** Deliberately saves only labels/coordinates/identity, not cached provider details or location history. */
export class SavedPlaces {
  constructor(
    private readonly key: string,
    private readonly storage?: Pick<Storage, "getItem" | "setItem">,
  ) {}
  private target() {
    return this.storage ?? localStorage;
  }
  read(): readonly SavedPlace[] {
    try {
      const raw = this.target().getItem(this.key);
      if (raw === null) return [];
      if (raw.length > 300000) throw new Error();
      const data = JSON.parse(raw);
      if (
        data.version !== 1 ||
        !Array.isArray(data.items) ||
        data.items.length > LIMIT
      )
        throw new Error();
      const ids = new Set<string>();
      return data.items.map((item: SavedPlace) => {
        if (
          !item ||
          !/^[A-Za-z0-9-]{1,80}$/.test(item.id) ||
          ids.has(item.id) ||
          !boundedText(item.label, 300) ||
          !Number.isFinite(item.savedAt) ||
          item.savedAt <= 0
        )
          throw new Error();
        if (
          (item.providerId === undefined) !==
          (item.providerPlaceId === undefined)
        )
          throw new Error();
        if (
          item.providerId !== undefined &&
          (!boundedText(item.providerId, 80) ||
            !boundedText(item.providerPlaceId, 512))
        )
          throw new Error();
        ids.add(item.id);
        return {
          id: item.id,
          label: item.label,
          coordinate: coordinate(item.coordinate),
          savedAt: item.savedAt,
          ...(item.providerId
            ? {
                providerId: item.providerId,
                providerPlaceId: item.providerPlaceId,
              }
            : {}),
        };
      });
    } catch {
      throw new MapsFailure(
        "storage",
        "Saved places could not be read. Existing data has not been replaced.",
      );
    }
  }
  private write(items: readonly SavedPlace[]) {
    const value = JSON.stringify({ version: 1, items });
    try {
      this.target().setItem(this.key, value);
      if (this.target().getItem(this.key) !== value) throw new Error();
    } catch {
      throw new MapsFailure(
        "storage",
        "Saved places could not be confirmed on this device.",
      );
    }
    return items;
  }
  save(input: {
    label: string;
    coordinate: Coordinate;
    providerId?: string;
    providerPlaceId?: string;
  }): SavedPlace {
    if (
      !boundedText(input.label, 300) ||
      (input.providerId === undefined) !==
        (input.providerPlaceId === undefined) ||
      (input.providerId !== undefined &&
        (!boundedText(input.providerId, 80) ||
          !boundedText(input.providerPlaceId, 512)))
    )
      throw new MapsFailure(
        "invalid-response",
        "A name and valid place identity are required.",
      );
    const position = coordinate(input.coordinate),
      items = this.read();
    const existing = items.find((p) =>
      input.providerId
        ? p.providerId === input.providerId &&
          p.providerPlaceId === input.providerPlaceId
        : !p.providerId &&
          p.coordinate.latitude === position.latitude &&
          p.coordinate.longitude === position.longitude,
    );
    if (!existing && items.length >= LIMIT)
      throw new MapsFailure(
        "storage",
        "Remove a saved place before adding another.",
      );
    const item: SavedPlace = {
      id: existing?.id || crypto.randomUUID(),
      label: input.label.trim(),
      coordinate: position,
      savedAt: Date.now(),
      ...(input.providerId
        ? {
            providerId: input.providerId,
            providerPlaceId: input.providerPlaceId,
          }
        : {}),
    };
    this.write(
      existing
        ? items.map((p) => (p.id === existing.id ? item : p))
        : [...items, item],
    );
    return item;
  }
  rename(id: string, label: string): readonly SavedPlace[] {
    if (!boundedText(label, 300))
      throw new MapsFailure(
        "invalid-response",
        "A saved-place name is required.",
      );
    const items = this.read();
    if (!items.some((p) => p.id === id))
      throw new MapsFailure(
        "unavailable",
        "This saved place no longer exists.",
      );
    return this.write(
      items.map((p) => (p.id === id ? { ...p, label: label.trim() } : p)),
    );
  }
  remove(id: string): readonly SavedPlace[] {
    return this.write(this.read().filter((p) => p.id !== id));
  }
}
