# Zustand Stores

This directory contains global state management using Zustand.

## Architecture

We use Zustand for clean, simple state management without the boilerplate of Context providers.

### Benefits

- **No Provider Wrappers**: Direct store access from any component
- **TypeScript First**: Full type safety
- **DevTools**: Built-in Redux DevTools support
- **Performance**: Automatic re-render optimization
- **Simple API**: Easy to read and maintain

## Stores

### `chat-store.ts`

Manages chat-related state including:

- Rooms (conversations)
- Room selection
- Characters (AI agents)
- Character selection
- Entity ID management

#### Usage Example

```typescript
import { useChatStore } from '@/lib/stores/chat-store';

function MyComponent() {
  // Select only what you need (component only re-renders when these change)
  const { rooms, createRoom, loadRooms } = useChatStore();

  // Actions
  const handleNewRoom = async () => {
    const roomId = await createRoom();
    console.log('Created room:', roomId);
  };

  return (
    <div>
      {rooms.map(room => (
        <div key={room.id}>{room.id}</div>
      ))}
      <button onClick={handleNewRoom}>New Room</button>
    </div>
  );
}
```

#### Store Structure

```typescript
interface ChatState {
  // State
  rooms: RoomItem[];
  roomId: string | null;
  isLoadingRooms: boolean;
  availableCharacters: Character[];
  selectedCharacterId: string | null;
  pendingMessage: string | null;
  anonymousSessionToken: string | null;

  // Actions
  setRooms: (rooms: RoomItem[]) => void;
  setRoomId: (roomId: string | null) => void;
  setIsLoadingRooms: (isLoading: boolean) => void;
  setAvailableCharacters: (characters: Character[]) => void;
  setSelectedCharacterId: (characterId: string | null) => void;
  setPendingMessage: (message: string | null) => void;
  setAnonymousSessionToken: (token: string | null) => void;
  loadRooms: (force?: boolean) => Promise<void>;
  createRoom: (characterId?: string | null) => Promise<string | null>;
  deleteRoom: (roomId: string) => Promise<void>;
  clearChatData: () => void;
}
```

## Best Practices

### 1. Select Only What You Need

```typescript
// ❌ Bad - component re-renders on any store change
const store = useChatStore();

// ✅ Good - only re-renders when rooms or loadRooms change
const { rooms, loadRooms } = useChatStore();
```

### 2. Use Selectors for Derived State

```typescript
// ✅ Good - computed value
const activeRoom = useChatStore((state) =>
  state.rooms.find((r) => r.id === state.roomId),
);
```

### 3. Keep Actions Simple

```typescript
// Actions should be pure and handle their own side effects
const createRoom = async (characterId?: string | null) => {
  try {
    const response = await fetch("/api/eliza/rooms", {
      method: "POST",
      body: JSON.stringify({ characterId }),
    });
    const data = await response.json();
    return data.roomId;
  } catch (error) {
    console.error("Error creating room:", error);
    return null;
  }
};
```

## Adding New Stores

1. Create a new file in `/lib/stores/` (e.g., `user-store.ts`)
2. Define your state interface
3. Create the store with `create()`
4. Export typed selectors if needed
5. Document usage in this README

Example:

```typescript
// lib/stores/user-store.ts
import { create } from "zustand";

interface UserState {
  user: User | null;
  setUser: (user: User | null) => void;
}

export const useUserStore = create<UserState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
}));
```

## Testing

Stores can be easily tested by importing and calling actions:

```typescript
import { useChatStore } from "@/stores/chat-store";

test("creates room", async () => {
  const { createRoom } = useChatStore.getState();
  const roomId = await createRoom("character-123");
  expect(roomId).toBeDefined();
});
```
