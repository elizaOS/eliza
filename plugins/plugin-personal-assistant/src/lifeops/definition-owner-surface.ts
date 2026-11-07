/** Shared owner classification for action review and persisted UI projections. */
import type { LifeOpsTaskDefinition } from "@elizaos/contracts";
import { readNativeAppleReminderMetadata } from "./apple-reminders.js";

const OWNER_DEFINITION_SURFACES = [
  "OWNER_TODOS",
  "OWNER_REMINDERS",
  "OWNER_ALARMS",
  "OWNER_ROUTINES",
] as const;

export type OwnerDefinitionSurface = (typeof OWNER_DEFINITION_SURFACES)[number];

export function ownerDefinitionSurface(
  value: unknown,
): OwnerDefinitionSurface | null {
  return typeof value === "string" &&
    OWNER_DEFINITION_SURFACES.includes(value as OwnerDefinitionSurface)
    ? (value as OwnerDefinitionSurface)
    : null;
}

export function resolveOwnerDefinitionSurface(
  definition: Pick<LifeOpsTaskDefinition, "kind" | "metadata">,
): OwnerDefinitionSurface | null {
  const persisted = ownerDefinitionSurface(definition.metadata.ownerSurface);
  if (persisted) return persisted;
  const nativeReminder = readNativeAppleReminderMetadata(definition.metadata);
  if (nativeReminder?.kind === "alarm") return "OWNER_ALARMS";
  if (nativeReminder?.kind === "reminder") return "OWNER_REMINDERS";
  if (definition.kind === "task") return "OWNER_TODOS";
  if (definition.kind === "habit" || definition.kind === "routine") {
    return "OWNER_ROUTINES";
  }
  return null;
}
