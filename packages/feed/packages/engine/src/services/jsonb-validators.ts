/**
 * JSONB Validators
 *
 * Zod schemas for validating JSONB columns that are type-asserted at runtime.
 * Provides safe parsing with fallbacks for corrupted or malformed data.
 *
 * Uses types from @feed/db (source of truth) and creates corresponding
 * Zod schemas for runtime validation.
 */

import type {
  NpcMemory,
  PendingTransition,
  PriceModifier,
  RelationshipState,
  ScheduledEvent,
} from '@feed/db';
import { isStringArray, logger } from '@feed/shared';
import { z } from 'zod';

// Re-export types from the source of truth for convenience
export type { NpcMemory, PriceModifier, RelationshipState } from '@feed/db';

/**
 * NPC Memory schema - validates against NpcMemory interface from @feed/db
 * Note: Using z.object directly (not z.ZodType) to preserve .omit() method
 */
export const NpcMemorySchema = z.object({
  id: z.string(),
  type: z.enum([
    'posted',
    'replied_to',
    'mentioned_by',
    'witnessed_event',
    'traded',
    'running_bit',
  ]),
  timestamp: z.string(), // ISO date string
  summary: z.string(),
  actorIds: z.array(z.string()).optional(),
  eventId: z.string().optional(),
  questionId: z.string().optional(),
  sentiment: z.number().min(-1).max(1),
}) satisfies z.ZodType<NpcMemory>;

/**
 * Array of NPC memories
 */
export const NpcMemoriesSchema = z.array(NpcMemorySchema);

/**
 * Partial memory schema for creation (without id)
 */
export const PartialMemorySchema = NpcMemorySchema.omit({ id: true });

/**
 * Relationship State schema - validates against RelationshipState interface from @feed/db
 */
export const RelationshipStateSchema = z.object({
  actorId: z.string(),
  sentiment: z.number().min(-1).max(1),
  lastInteraction: z.string(), // ISO date string
  interactionCount: z.number().int().min(0),
  notes: z.array(z.string()),
}) satisfies z.ZodType<RelationshipState>;

/**
 * Map of relationships keyed by actor ID
 */
export const RelationshipsMapSchema = z.record(
  z.string(),
  RelationshipStateSchema
);

/**
 * Interaction update schema for relationship updates
 */
export const InteractionUpdateSchema = z.object({
  sentimentChange: z.number().min(-1).max(1),
  note: z.string().optional(),
});

/**
 * Safely parse NPC memories from JSONB with fallback to empty array.
 * Logs a warning for invalid data but doesn't throw.
 */
export function parseMemoriesSafe(
  data: unknown,
  context?: { actorId?: string }
): NpcMemory[] {
  if (data === null || data === undefined) {
    return [];
  }

  const result = NpcMemoriesSchema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  // Log the validation error but don't throw
  logger.warn(
    'Invalid memories JSONB data',
    {
      actorId: context?.actorId,
      issues: result.error.issues.slice(0, 3),
    },
    'JSONBValidation'
  );

  // Try to salvage valid memories from the array
  if (Array.isArray(data)) {
    const validMemories: NpcMemory[] = [];
    let discardedCount = 0;
    for (const item of data) {
      const itemResult = NpcMemorySchema.safeParse(item);
      if (itemResult.success) {
        validMemories.push(itemResult.data);
      } else {
        discardedCount++;
      }
    }

    // Log salvage statistics
    if (discardedCount > 0) {
      logger.info(
        'Salvaged partial memories from corrupted data',
        {
          actorId: context?.actorId,
          salvaged: validMemories.length,
          discarded: discardedCount,
          total: data.length,
        },
        'JSONBValidation'
      );
    }

    return validMemories;
  }

  return [];
}

/**
 * Safely parse relationships map from JSONB with fallback to empty object.
 * Logs a warning for invalid data but doesn't throw.
 */
export function parseRelationshipsSafe(
  data: unknown,
  context?: { actorId?: string }
): Record<string, RelationshipState> {
  if (data === null || data === undefined) {
    return {};
  }

  const result = RelationshipsMapSchema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  // Log the validation error but don't throw
  logger.warn(
    'Invalid relationships JSONB data',
    {
      actorId: context?.actorId,
      issues: result.error.issues.slice(0, 3),
    },
    'JSONBValidation'
  );

  // Try to salvage valid relationships from the object
  // Limit inspection to first N entries to avoid expensive iteration on large maps
  if (typeof data === 'object' && data !== null) {
    const MAX_SALVAGE = 1000;
    const validRelationships: Record<string, RelationshipState> = {};
    let discardedCount = 0;
    let inspectedCount = 0;
    let capHit = false;
    const entries = Object.entries(data);

    for (const [key, value] of entries) {
      if (inspectedCount >= MAX_SALVAGE) {
        capHit = true;
        break;
      }
      inspectedCount++;

      const itemResult = RelationshipStateSchema.safeParse(value);
      if (itemResult.success) {
        validRelationships[key] = itemResult.data;
      } else {
        discardedCount++;
      }
    }

    // Compute entries skipped due to cap (not inspected at all)
    const skippedDueToCap = Math.max(0, entries.length - inspectedCount);

    // Log salvage statistics
    if (discardedCount > 0 || capHit) {
      logger.info(
        'Salvaged partial relationships from corrupted data',
        {
          actorId: context?.actorId,
          salvaged: Object.keys(validRelationships).length,
          discarded: discardedCount,
          inspectedCount,
          total: entries.length,
          capHit,
          skippedDueToCap,
        },
        'JSONBValidation'
      );
    }

    return validRelationships;
  }

  return {};
}

/**
 * Validate a single memory object before inserting.
 * Throws if invalid - use for write operations.
 */
export function validateMemory(
  memory: unknown
): asserts memory is Omit<NpcMemory, 'id'> {
  PartialMemorySchema.parse(memory);
}

/**
 * Validate a single relationship update before writing.
 * Throws if invalid - use for write operations.
 */
export function validateRelationshipUpdate(
  interaction: unknown
): asserts interaction is z.infer<typeof InteractionUpdateSchema> {
  InteractionUpdateSchema.parse(interaction);
}

/**
 * PriceModifier schema - validates against PriceModifier interface from @feed/db
 */
export const PriceModifierSchema = z.object({
  eventId: z.string(),
  effect: z.number().min(0.01).max(10), // Effect multiplier bounded 0.01x to 10x
  decayRate: z.number().min(0).max(1), // Decay rate 0-100% per hour
  appliedAt: z.string(), // ISO date string
  expiresAt: z.string(), // ISO date string
}) satisfies z.ZodType<PriceModifier>;

/**
 * Array of price modifiers
 */
export const PriceModifiersSchema = z.array(PriceModifierSchema);

/**
 * Safely parse price modifiers from JSONB with fallback to empty array.
 * Logs a warning for invalid data but doesn't throw.
 */
export function parseModifiersSafe(
  data: unknown,
  context?: { orgId?: string }
): PriceModifier[] {
  if (data === null || data === undefined) {
    return [];
  }

  const result = PriceModifiersSchema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  // Log the validation error but don't throw
  logger.warn(
    'Invalid modifiers JSONB data',
    {
      orgId: context?.orgId,
      issues: result.error.issues.slice(0, 3),
    },
    'JSONBValidation'
  );

  // Try to salvage valid modifiers from the array
  if (Array.isArray(data)) {
    const validModifiers: PriceModifier[] = [];
    let discardedCount = 0;
    for (const item of data) {
      const itemResult = PriceModifierSchema.safeParse(item);
      if (itemResult.success) {
        validModifiers.push(itemResult.data);
      } else {
        discardedCount++;
      }
    }

    // Log salvage statistics
    if (discardedCount > 0) {
      logger.info(
        'Salvaged partial modifiers from corrupted data',
        {
          orgId: context?.orgId,
          salvaged: validModifiers.length,
          discarded: discardedCount,
          total: data.length,
        },
        'JSONBValidation'
      );
    }

    return validModifiers;
  }

  return [];
}

/**
 * Validate a single price modifier before inserting.
 * Throws if invalid - use for write operations.
 */
export function validatePriceModifier(
  modifier: unknown
): asserts modifier is PriceModifier {
  PriceModifierSchema.parse(modifier);
}

// =============================================================================
// STRING ARRAY VALIDATORS (for actors, tags, etc.)
// =============================================================================

/**
 * String array schema - validates arrays of strings
 */
export const StringArraySchema = z.array(z.string());

/**
 * Safely parse a string array from JSONB with fallback to empty array.
 * Common use case: actors, tags, mentions, etc.
 */
export function parseStringArraySafe(
  data: unknown,
  context?: { field?: string }
): string[] {
  if (data === null || data === undefined) {
    return [];
  }

  // Fast path: already a valid string array using type guard
  // Note: isStringArray validates the same shape as StringArraySchema.safeParse,
  // so we skip the redundant safeParse and fall through directly to salvage logic
  if (isStringArray(data)) {
    return data;
  }

  // Log warning and try to salvage valid strings
  logger.warn(
    'Invalid string array JSONB data',
    {
      field: context?.field,
      dataType: typeof data,
      isArray: Array.isArray(data),
    },
    'JSONBValidation'
  );

  // Salvage valid strings from array with metrics
  if (Array.isArray(data)) {
    const originalCount = data.length;
    const filtered = data.filter(
      (item): item is string => typeof item === 'string'
    );
    const keptCount = filtered.length;
    const droppedCount = originalCount - keptCount;

    // Log salvage metrics for observability
    if (droppedCount > 0) {
      logger.info(
        'JSONBSalvage: salvaged partial string array data',
        {
          field: context?.field,
          originalCount,
          keptCount,
          droppedCount,
        },
        'JSONBValidation'
      );
    }

    return filtered;
  }

  return [];
}

export { isStringArray } from '@feed/shared';

// =============================================================================
// NARRATIVE ARC VALIDATORS (PendingTransition, ScheduledEvent)
// =============================================================================

/**
 * PendingTransition schema for arc state transitions.
 *
 * Note: targetState accepts any string rather than validating against the concrete
 * ArcStateType union. This is intentional for future-proofing - new arc states can
 * be added without requiring schema updates. The PendingTransition interface in
 * @feed/db defines the canonical ArcStateType constraint; this schema provides
 * looser runtime validation for flexibility.
 */
export const PendingTransitionSchema = z.object({
  targetState: z.string(),
  triggerDay: z.number(),
  triggerEventType: z.string().optional(),
  probability: z.number().min(0).max(1).optional(),
});

/**
 * Array of pending transitions
 */
export const PendingTransitionsSchema = z.array(PendingTransitionSchema);

/**
 * ScheduledEvent schema for deterministic narrative firing
 */
export const ScheduledEventSchema = z.object({
  baseDay: z.number(),
  jitterHours: z.number(),
  eventType: z.enum([
    'leak',
    'rumor',
    'scandal',
    'confirmation',
    'red_herring',
  ]),
  description: z.string(),
  signalDirection: z.enum(['YES', 'NO', 'NEUTRAL']),
  fired: z.boolean(),
  firedAt: z.string().optional(),
});

/**
 * Array of scheduled events
 */
export const ScheduledEventsSchema = z.array(ScheduledEventSchema);

/**
 * Safely parse pending transitions from JSONB with fallback to empty array.
 */
export function parsePendingTransitionsSafe(
  data: unknown,
  context?: { arcId?: string }
): PendingTransition[] {
  if (data === null || data === undefined) {
    return [];
  }

  const result = PendingTransitionsSchema.safeParse(data);
  if (result.success) {
    return result.data as PendingTransition[];
  }

  logger.warn(
    'Invalid pendingTransitions JSONB data',
    {
      arcId: context?.arcId,
      issues: result.error.issues.slice(0, 3),
    },
    'JSONBValidation'
  );

  // Try to salvage valid transitions with metrics logging
  if (Array.isArray(data)) {
    const valid: PendingTransition[] = [];
    let total = 0;
    let invalid = 0;
    for (const item of data) {
      total++;
      const itemResult = PendingTransitionSchema.safeParse(item);
      if (itemResult.success) {
        valid.push(itemResult.data as PendingTransition);
      } else {
        invalid++;
      }
    }

    // Log salvage metrics only when there are actually invalid entries
    if (invalid > 0) {
      logger.info(
        'Salvaged partial PendingTransition data',
        {
          parser: 'PendingTransition',
          arcId: context?.arcId,
          total,
          valid: valid.length,
          invalid,
        },
        'JSONBValidation'
      );
    }

    return valid;
  }

  return [];
}

/**
 * Safely parse scheduled events from JSONB with fallback to empty array.
 */
export function parseScheduledEventsSafe(
  data: unknown,
  context?: { questionId?: string }
): ScheduledEvent[] {
  if (data === null || data === undefined) {
    return [];
  }

  const result = ScheduledEventsSchema.safeParse(data);
  if (result.success) {
    return result.data as ScheduledEvent[];
  }

  logger.warn(
    'Invalid eventSchedule JSONB data',
    {
      questionId: context?.questionId,
      issues: result.error.issues.slice(0, 3),
    },
    'JSONBValidation'
  );

  // Try to salvage valid events with metrics logging
  if (Array.isArray(data)) {
    const valid: ScheduledEvent[] = [];
    let total = 0;
    let invalid = 0;
    for (const item of data) {
      total++;
      const itemResult = ScheduledEventSchema.safeParse(item);
      if (itemResult.success) {
        valid.push(itemResult.data as ScheduledEvent);
      } else {
        invalid++;
      }
    }

    // Log salvage metrics only when there are actually invalid entries
    if (invalid > 0) {
      logger.info(
        'Salvaged partial ScheduledEvent data',
        {
          parser: 'ScheduledEvent',
          questionId: context?.questionId,
          total,
          valid: valid.length,
          invalid,
        },
        'JSONBValidation'
      );
    }

    return valid;
  }

  return [];
}
