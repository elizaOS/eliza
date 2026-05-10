SCHEDULING_NEGOTIATION parameter typing rationale (2026-05-10):
The action is defined in `lib/scheduling-handler.ts` (re-exported from
`scheduling-negotiation.ts`).

- `subaction` enum sourced from new `SCHEDULING_SUBACTIONS` const so the
  exported schema mirrors the runtime `SchedulingSubaction` type.
- `response` enum + `proposedBy` enum sourced from the existing inline
  union types — extracted to const arrays for reuse in the schema.
- Added `proposedBy`, `relationshipId`, `timezone`, `reason` to the
  parameters array (handler already reads them — they were silently
  unsigned before; this matches `SchedulingActionParameters`).
- `durationMinutes` gets minimum:5 / maximum:1440 to match handler bounds
  (LifeOps service rejects 0 / >24h durations downstream).
- No fields top-level required: handler routes through `resolveSchedulingPlanWithLlm` and emits `requiresConfirmation: true` per-branch when needed.
