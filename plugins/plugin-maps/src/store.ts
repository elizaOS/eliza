/** Persists owner-scoped saved places through the runtime's canonical memory API. */

import { createHash } from "node:crypto";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { MemoryType } from "@elizaos/core";
import { MapsError } from "./errors.js";
import {
  type SavedPlace,
  type SavePlaceRequest,
  type SavePlaceResult,
  savedPlaceSchema,
} from "./types.js";

export const SAVED_PLACES_TABLE = "maps_saved_places";
const SAVED_PLACE_SOURCE = "plugin-maps.saved-place.v1";

function uuidFromKey(key: string): UUID {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}` as UUID;
}

function samePlace(a: SavedPlace, request: SavePlaceRequest): boolean {
  return (
    a.place.provider === request.place.provider &&
    a.place.providerPlaceId === request.place.providerPlaceId
  );
}

function readSavedPlace(memory: Memory): SavedPlace {
  const metadata = memory.metadata as Record<string, unknown> | undefined;
  const parsed = savedPlaceSchema.safeParse(metadata?.savedPlace);
  if (!parsed.success) {
    throw new MapsError("A persisted saved place is malformed.", {
      code: "MAPS_STORAGE_FAILURE",
      cause: parsed.error,
      context: { memoryId: memory.id },
    });
  }
  return parsed.data;
}

export interface SavedPlaceStore {
  save(request: SavePlaceRequest): Promise<SavePlaceResult>;
  list(ownerEntityId: string): Promise<SavedPlace[]>;
  get(ownerEntityId: string, savedPlaceId: string): Promise<SavedPlace | null>;
}

export class RuntimeSavedPlaceStore implements SavedPlaceStore {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly runtime: IAgentRuntime) {}

  async save(request: SavePlaceRequest): Promise<SavePlaceResult> {
    const lockKey = `${request.ownerEntityId}:${request.idempotencyKey ?? `${request.place.provider}:${request.place.providerPlaceId}`}`;
    const prior = this.locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(lockKey, current);
    await prior;
    try {
      return await this.saveLocked(request);
    } finally {
      release();
      if (this.locks.get(lockKey) === current) this.locks.delete(lockKey);
    }
  }

  async list(ownerEntityId: string): Promise<SavedPlace[]> {
    try {
      const rows = await this.runtime.getMemories({
        tableName: SAVED_PLACES_TABLE,
        agentId: this.runtime.agentId,
        entityId: ownerEntityId as UUID,
        metadata: { source: SAVED_PLACE_SOURCE },
        limit: 500,
        orderBy: "createdAt",
        orderDirection: "asc",
      });
      return rows.map(readSavedPlace);
    } catch (error) {
      if (error instanceof MapsError) throw error;
      // error-policy:J2 Saved-place persistence is authoritative; wrap storage
      // failures with owner scope and preserve the database cause.
      throw new MapsError("Saved places could not be read.", {
        code: "MAPS_STORAGE_FAILURE",
        cause: error,
        context: { ownerEntityId },
      });
    }
  }

  async get(
    ownerEntityId: string,
    savedPlaceId: string,
  ): Promise<SavedPlace | null> {
    return (
      (await this.list(ownerEntityId)).find(
        (savedPlace) => savedPlace.id === savedPlaceId,
      ) ?? null
    );
  }

  private async saveLocked(
    request: SavePlaceRequest,
  ): Promise<SavePlaceResult> {
    const places = await this.list(request.ownerEntityId);
    const byIdempotency = request.idempotencyKey
      ? places.find((place) => place.idempotencyKey === request.idempotencyKey)
      : undefined;
    if (byIdempotency) {
      if (!samePlace(byIdempotency, request)) {
        throw new MapsError(
          "The idempotency key belongs to another saved place.",
          {
            code: "MAPS_INVALID_INPUT",
            context: { idempotencyKey: request.idempotencyKey },
          },
        );
      }
      return {
        savedPlace: byIdempotency,
        replayed: true,
        commitId: byIdempotency.id,
      };
    }

    const existing = places.find((place) => samePlace(place, request));
    const label = request.label?.trim() || request.place.name;
    if (existing && existing.label === label) {
      return { savedPlace: existing, replayed: true, commitId: existing.id };
    }

    const now = new Date().toISOString();
    const id =
      existing?.id ??
      uuidFromKey(
        `maps-saved-place-v1:${this.runtime.agentId}:${request.ownerEntityId}:${request.place.provider}:${request.place.providerPlaceId}`,
      );
    const idempotencyKey = request.idempotencyKey?.trim() || `maps-save:${id}`;
    const parsedSavedPlace = savedPlaceSchema.safeParse({
      id,
      ownerEntityId: request.ownerEntityId,
      place: request.place,
      label,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      idempotencyKey,
    });
    if (!parsedSavedPlace.success) {
      throw new MapsError("The saved-place request is invalid.", {
        code: "MAPS_INVALID_INPUT",
        cause: parsedSavedPlace.error,
      });
    }
    const savedPlace = parsedSavedPlace.data;
    const metadata = {
      type: MemoryType.CUSTOM,
      source: SAVED_PLACE_SOURCE,
      savedPlace,
    } as Memory["metadata"];

    try {
      if (existing) {
        await this.runtime.updateMemory({
          id: existing.id as UUID,
          content: {
            text: `Saved place: ${savedPlace.label}`,
            type: "maps_saved_place",
          },
          metadata,
        });
      } else {
        await this.runtime.createMemory(
          {
            id,
            agentId: this.runtime.agentId,
            entityId: request.ownerEntityId as UUID,
            roomId: request.roomId as UUID,
            content: {
              text: `Saved place: ${savedPlace.label}`,
              type: "maps_saved_place",
            },
            metadata,
          } as Memory,
          SAVED_PLACES_TABLE,
          true,
        );
      }
    } catch (error) {
      // error-policy:J2 A save is complete only after the runtime store accepts
      // it; preserve the failing store operation as the cause.
      throw new MapsError("The place could not be saved.", {
        code: "MAPS_STORAGE_FAILURE",
        cause: error,
        context: { savedPlaceId: id },
      });
    }
    return { savedPlace, replayed: false, commitId: id };
  }
}
