import { readStorageJson, writeStorageItem } from "@/utils/browser-storage";

const GAME_GUIDE_COMPLETED_KEY = "feed-game-guide-completed";

export function hasCompletedGameGuide(
  userId: string | undefined,
  apiCompletedAt: string | null | undefined,
): boolean {
  if (apiCompletedAt) return true;
  if (typeof window === "undefined" || !userId) return false;
  const completedUsers = readStorageJson<Record<string, boolean>>(
    "localStorage",
    GAME_GUIDE_COMPLETED_KEY,
  );
  return completedUsers?.[userId] === true;
}

export function markGameGuideCompletedLocal(userId: string): void {
  if (typeof window === "undefined") return;
  const completedUsers =
    readStorageJson<Record<string, boolean>>(
      "localStorage",
      GAME_GUIDE_COMPLETED_KEY,
    ) ?? {};
  completedUsers[userId] = true;
  writeStorageItem(
    "localStorage",
    GAME_GUIDE_COMPLETED_KEY,
    JSON.stringify(completedUsers),
  );
}
