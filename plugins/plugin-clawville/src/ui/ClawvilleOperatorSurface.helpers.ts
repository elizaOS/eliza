// Shared (non-component) constants for the ClawVille operator surface. Kept out
// of ClawvilleOperatorSurface.tsx so that file exports only React components and
// stays Fast-Refresh-compatible. Used by both the view components and the
// view-bundle `interact` handler.

export const PRIMARY_COMMANDS = [
  {
    id: "visit-nearest",
    label: "Visit nearest",
    command: "Visit the nearest building",
    testId: "clawville-command-visit-nearest",
  },
  {
    id: "ask-npc",
    label: "Ask NPC",
    command: "Ask the nearest NPC what to learn next",
    testId: "clawville-command-ask-npc",
  },
] as const;
