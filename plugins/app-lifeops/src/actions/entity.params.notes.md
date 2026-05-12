ENTITY parameter typing rationale (2026-05-10):
- `subaction` enum reuses `ENTITY_SUBACTIONS` const so the wire schema matches the runtime guard.
- `channel` enum reuses `LIFEOPS_MESSAGE_CHANNELS` so external agents see the same closed set the handler validates against (it explicitly errors on unknown channel).
- `platform` and `relationshipType` are intentionally NOT enums (they're open-ended labels that EntityStore.observeIdentity / RelationshipStore.upsert accept any string for) — but `examples` and a richer `descriptionCompressed` give external models concrete patterns.
- No fields marked required: handler routes through an LLM planner (`resolveRelationshipPlanWithLlm`) when fields are absent and prompts the user for missing required-by-subaction fields per branch.
