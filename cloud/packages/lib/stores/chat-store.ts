/**
 * Chat Store - Zustand
 * Manages chat state including rooms, characters, and selections
 *
 * NOTE: entityId is now derived from authenticated user on the server, not stored locally.
 * This is a security improvement - clients cannot spoof their identity.
 */

import { create } from "zustand";
import type { RoomPreview } from "@/lib/services/agents/rooms";

export interface RoomItem {
  id: string;
  lastText?: string;
  lastTime?: number;
  characterId?: string;
  characterName?: string;
  title?: string; // AI-generated title from first user message
  isLocked?: boolean; // Whether the room is locked (character was created/saved)
  isBuildRoom?: boolean; // Whether this is a legacy builder room
}

export interface Character {
  id: string;
  name: string;
  username?: string;
  avatarUrl?: string;
  bio?: string;
  creatorUsername?: string;
  ownerId?: string;
}

export type ViewerState = "unauthenticated" | "non-owner" | "owner";

/**
 * Compute viewer state based on authentication and character ownership.
 * Centralized helper to prevent race conditions between setAuthState and setSelectedCharacterId.
 */

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRoomPreview(value: unknown): value is RoomPreview {
  return isJsonRecord(value) && typeof value.id === "string";
}

function toRoomPreview(value: unknown): RoomPreview | null {
  if (!isRoomPreview(value)) return null;
  return {
    id: value.id,
    title: optionalString(value.title),
    characterId: optionalString(value.characterId),
    characterName: optionalString(value.characterName),
    characterAvatarUrl: optionalString(value.characterAvatarUrl),
    lastTime: optionalNumber(value.lastTime),
    lastText: optionalString(value.lastText),
    isLocked: optionalBoolean(value.isLocked),
    isBuildRoom: optionalBoolean(value.isBuildRoom),
  };
}

function roomsFromResponse(value: unknown): RoomPreview[] {
  if (!isJsonRecord(value) || !Array.isArray(value.rooms)) return [];
  return value.rooms.flatMap((room) => {
    const preview = toRoomPreview(room);
    return preview ? [preview] : [];
  });
}

function roomIdFromResponse(value: unknown): string | null {
  return isJsonRecord(value) && typeof value.roomId === "string" ? value.roomId : null;
}

function errorMessageFromResponse(value: unknown): string | null {
  return isJsonRecord(value) && typeof value.error === "string" ? value.error : null;
}

function computeViewerState(
  isAuthenticated: boolean,
  currentUserId: string | null,
  selectedCharacterId: string | null,
  availableCharacters: Character[],
): ViewerState {
  if (!isAuthenticated || !currentUserId) {
    return "unauthenticated";
  }

  // No character selected = creator mode = owner
  if (!selectedCharacterId) {
    return "owner";
  }

  // Check if user owns the selected character
  const selectedChar = availableCharacters.find((c) => c.id === selectedCharacterId);
  // Only treat as owner if ownerId explicitly matches - missing ownerId means unknown ownership
  if (selectedChar?.ownerId === currentUserId) {
    return "owner";
  }

  return "non-owner";
}

interface ChatState {
  // State
  rooms: RoomItem[];
  roomId: string | null;
  isLoadingRooms: boolean;
  availableCharacters: Character[];
  selectedCharacterId: string | null;
  pendingMessage: string | null; // Message from landing page to auto-send
  loadRoomsPromise: Promise<void> | null; // Track ongoing loadRooms operation
  anonymousSessionToken: string | null; // Session token for anonymous users (from URL)
  recentlyDeletedRoomIds: Set<string>; // Track recently deleted rooms to prevent re-adding

  // Viewer state for public agent access control
  isAuthenticated: boolean;
  viewerState: ViewerState;
  currentUserId: string | null; // The logged-in user's ID

  // Actions
  setRooms: (rooms: RoomItem[]) => void;
  setRoomId: (roomId: string | null) => void;
  setIsLoadingRooms: (isLoading: boolean) => void;
  setAvailableCharacters: (characters: Character[]) => void;
  setSelectedCharacterId: (characterId: string | null) => void;
  setPendingMessage: (message: string | null) => void;
  setAnonymousSessionToken: (token: string | null) => void;
  setAuthState: (isAuthenticated: boolean, userId: string | null) => void;
  /**
   * Atomically set auth state and character selection together.
   * Use this when both need to be updated to prevent race conditions.
   */
  initializeState: (params: {
    isAuthenticated: boolean;
    userId: string | null;
    characters: Character[];
    selectedCharacterId: string | null;
  }) => void;
  updateRoom: (roomId: string, updates: Partial<Omit<RoomItem, "id">>) => void;
  updateCharacterAvatar: (characterId: string, avatarUrl: string) => void;
  loadRooms: (force?: boolean) => Promise<void>;
  createRoom: (characterId?: string | null) => Promise<string | null>;
  deleteRoom: (roomId: string) => Promise<void>;
  clearChatData: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  // Initial state
  rooms: [],
  roomId: null,
  isLoadingRooms: false,
  availableCharacters: [],
  selectedCharacterId: null,
  pendingMessage: null,
  loadRoomsPromise: null,
  anonymousSessionToken: null,
  recentlyDeletedRoomIds: new Set<string>(),

  // Viewer state
  isAuthenticated: false,
  viewerState: "unauthenticated" as ViewerState,
  currentUserId: null,

  // Setters
  setRooms: (rooms) => set({ rooms }),
  setRoomId: (roomId) => {
    set({ roomId });
    if (roomId && typeof window !== "undefined") {
      window.localStorage.setItem("elizaRoomId", roomId);
    }
  },
  setIsLoadingRooms: (isLoading) => set({ isLoadingRooms: isLoading }),
  setAvailableCharacters: (characters) => set({ availableCharacters: characters }),
  setSelectedCharacterId: (characterId) => {
    const { isAuthenticated, currentUserId, availableCharacters } = get();

    // Use centralized helper to compute viewer state
    const viewerState = computeViewerState(
      isAuthenticated,
      currentUserId,
      characterId,
      availableCharacters,
    );

    set({ selectedCharacterId: characterId, viewerState });
  },
  setPendingMessage: (message) => set({ pendingMessage: message }),
  setAnonymousSessionToken: (token) => set({ anonymousSessionToken: token }),

  // Set auth state and compute viewer state based on selected character ownership
  setAuthState: (isAuthenticated, userId) => {
    const { selectedCharacterId, availableCharacters } = get();

    // Use centralized helper to compute viewer state
    const viewerState = computeViewerState(
      isAuthenticated,
      userId,
      selectedCharacterId,
      availableCharacters,
    );

    set({ isAuthenticated, currentUserId: userId, viewerState });
  },

  // Atomically initialize auth state, characters, and selection together
  // Prevents race conditions when all three need to be set during page initialization
  initializeState: ({ isAuthenticated, userId, characters, selectedCharacterId }) => {
    // Compute viewer state with all the new values at once
    const viewerState = computeViewerState(
      isAuthenticated,
      userId,
      selectedCharacterId,
      characters,
    );

    set({
      isAuthenticated,
      currentUserId: userId,
      availableCharacters: characters,
      selectedCharacterId,
      viewerState,
    });
  },

  // Update an existing room's properties (for instant UI updates)
  updateRoom: (roomId: string, updates: Partial<Omit<RoomItem, "id">>) => {
    const { rooms } = get();
    const updatedRooms = rooms.map((room) => (room.id === roomId ? { ...room, ...updates } : room));
    set({ rooms: updatedRooms });
  },

  // Update a character's avatar URL after avatar generation
  updateCharacterAvatar: (characterId, avatarUrl) => {
    const { availableCharacters } = get();
    const updatedCharacters = availableCharacters.map((char) =>
      char.id === characterId ? { ...char, avatarUrl } : char,
    );
    set({ availableCharacters: updatedCharacters });
  },

  // Load rooms from API
  // entityId is now derived from authenticated user on the server
  loadRooms: async (force = false) => {
    const state = get();
    const { anonymousSessionToken } = state;

    // Deduplicate concurrent loadRooms calls
    if (!force && state.loadRoomsPromise) {
      return state.loadRoomsPromise;
    }

    const loadPromise = (async () => {
      set({ isLoadingRooms: true });

      try {
        // Server derives entityId from authenticated user
        const headers: Record<string, string> = {};

        // Pass anonymous session token if available (for affiliate flows)
        if (anonymousSessionToken) {
          headers["X-Anonymous-Session"] = anonymousSessionToken;
        }

        const res = await fetch(`/api/eliza/rooms`, {
          headers,
          credentials: "include",
        });

        if (res.ok) {
          const rooms = roomsFromResponse(await res.json());

          if (rooms.length > 0) {
            const roomItems: RoomItem[] = rooms.slice(0, 20).map((r) => ({
              id: r.id,
              characterId: r.characterId,
              characterName: r.characterName,
              lastText: r.lastText,
              lastTime: r.lastTime,
              title: r.title,
              isLocked: r.isLocked,
              isBuildRoom: r.isBuildRoom,
            }));

            const currentState = get();
            const existingCharacterIds = new Set(currentState.availableCharacters.map((c) => c.id));

            const charactersFromRooms: Character[] = [];
            for (const room of rooms) {
              if (
                room.characterId &&
                room.characterName &&
                !existingCharacterIds.has(room.characterId)
              ) {
                charactersFromRooms.push({
                  id: room.characterId,
                  name: room.characterName,
                  avatarUrl: room.characterAvatarUrl,
                });
                existingCharacterIds.add(room.characterId);
              }
            }

            const mergedCharacters = [...currentState.availableCharacters, ...charactersFromRooms];

            let newSelectedCharacterId = currentState.selectedCharacterId;
            if (
              !newSelectedCharacterId &&
              charactersFromRooms.length === 1 &&
              currentState.availableCharacters.length === 0
            ) {
              newSelectedCharacterId = charactersFromRooms[0].id;
            }

            // Compute viewerState when auto-selecting a character
            const viewerState = computeViewerState(
              currentState.isAuthenticated,
              currentState.currentUserId,
              newSelectedCharacterId,
              mergedCharacters,
            );

            // Filter out any recently deleted rooms to prevent them from reappearing
            const filteredRoomItems = roomItems.filter(
              (room) => !currentState.recentlyDeletedRoomIds.has(room.id),
            );

            set({
              rooms: filteredRoomItems,
              availableCharacters: mergedCharacters,
              selectedCharacterId: newSelectedCharacterId,
              viewerState,
            });
          }
        }
      } catch (error) {
        console.error("[ChatStore] Failed to load rooms:", error);
      } finally {
        // Always clear loading state and promise, even on error
        set({ isLoadingRooms: false, loadRoomsPromise: null });
      }
    })();

    set({ loadRoomsPromise: loadPromise });
    return loadPromise;
  },

  // Create new room
  // entityId is derived from authenticated user on the server
  createRoom: async (characterId?: string | null) => {
    const { setRoomId, anonymousSessionToken } = get();

    const requestBody: Record<string, string | undefined> = {
      characterId: characterId || undefined,
    };

    // Pass the session token for anonymous users
    if (anonymousSessionToken) {
      requestBody.sessionToken = anonymousSessionToken;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Also pass as header for redundancy
    if (anonymousSessionToken) {
      headers["X-Anonymous-Session"] = anonymousSessionToken;
    }

    const response = await fetch("/api/eliza/rooms", {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify(requestBody),
    });

    if (response.ok) {
      const newRoomId = roomIdFromResponse(await response.json());

      if (!newRoomId) {
        throw new Error("Room creation succeeded but returned empty ID. Check server logs.");
      }

      // Automatically switch to the new room
      // The room will appear in the sidebar once the agent replies
      setRoomId(newRoomId);

      return newRoomId;
    } else {
      const errorMessage = errorMessageFromResponse(await response.json());
      throw new Error(errorMessage ?? `Failed to create room: ${response.status}`);
    }
  },

  // Delete room - uses optimistic update for instant UI feedback
  deleteRoom: async (roomIdToDelete: string) => {
    // Optimistic update: remove from UI immediately before API call
    const currentState = get();
    const wasSelected = currentState.roomId === roomIdToDelete;
    const previousRooms = currentState.rooms;

    // Add to recently deleted set to prevent loadRooms from re-adding it
    const newDeletedSet = new Set(currentState.recentlyDeletedRoomIds);
    newDeletedSet.add(roomIdToDelete);

    // Update state immediately
    set({
      rooms: previousRooms.filter((r) => r.id !== roomIdToDelete),
      roomId: wasSelected ? null : currentState.roomId,
      recentlyDeletedRoomIds: newDeletedSet,
    });

    // Clear from localStorage if this was the selected room
    if (wasSelected && typeof window !== "undefined") {
      window.localStorage.removeItem("elizaRoomId");
    }

    // Make API call in background - don't await, fire and forget
    // The optimistic update has already removed the room from UI
    fetch(`/api/eliza/rooms/${roomIdToDelete}`, {
      method: "DELETE",
      credentials: "include",
    })
      .then((response) => {
        if (!response.ok) {
          // Log error but don't rollback - the server delete often succeeds
          // even when returning errors due to cascade operations
          console.warn("[ChatStore] Delete API returned error, but room may have been deleted");
        }
        // Always clean up the deleted set after a delay
        setTimeout(() => {
          const cleanupDeletedSet = new Set(get().recentlyDeletedRoomIds);
          cleanupDeletedSet.delete(roomIdToDelete);
          set({ recentlyDeletedRoomIds: cleanupDeletedSet });
        }, 5000);
      })
      .catch((error) => {
        console.error("[ChatStore] Delete request failed:", error);
        // Still clean up after delay - don't leave stale entries
        setTimeout(() => {
          const cleanupDeletedSet = new Set(get().recentlyDeletedRoomIds);
          cleanupDeletedSet.delete(roomIdToDelete);
          set({ recentlyDeletedRoomIds: cleanupDeletedSet });
        }, 5000);
      });
  },

  // Clear all chat data on logout
  clearChatData: () => {
    // Clear localStorage items
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("elizaRoomId");
      window.localStorage.removeItem("eliza-anon-session-token");
    }

    // Reset store state
    set({
      rooms: [],
      roomId: null,
      isLoadingRooms: false,
      availableCharacters: [],
      selectedCharacterId: null,
      pendingMessage: null,
      loadRoomsPromise: null,
      anonymousSessionToken: null,
      recentlyDeletedRoomIds: new Set<string>(),
      isAuthenticated: false,
      viewerState: "unauthenticated" as ViewerState,
      currentUserId: null,
    });
  },
}));

// Subscribe to migration events to clear anonymous session token
if (typeof window !== "undefined") {
  window.addEventListener("anonymous-session-migrated", () => {
    useChatStore.getState().setAnonymousSessionToken(null);
  });
}
