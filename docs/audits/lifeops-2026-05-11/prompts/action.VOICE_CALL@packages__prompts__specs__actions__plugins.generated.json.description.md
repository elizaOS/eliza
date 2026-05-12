# `action.VOICE_CALL@packages/prompts/specs/actions/plugins.generated.json.description`

- **Kind**: action-description
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 127
- **Last optimized**: never
- **Action**: VOICE_CALL
- **Similes**: PLACE_CALL, CALL_ME, ESCALATE_TO_USER, CALL_THIRD_PARTY, PHONE_SOMEONE, DIAL

## Current text
```
Owner-only. Place an outbound voice call via a registered provider. Action: `dial` with recipientKind=owner|external|e164. Current dispatch provider is Twilio; Android/app-phone is implementation-only until wired as a VOICE_CALL provider. Owner uses the env-configured owner number + standing escalation policy; external resolves a contact name via relationships then checks the allow-list; e164 dials a raw phone number. All paths draft first, require confirmed:true to dispatch, and use the approval queue.
```

## Compressed variant
```
Twilio voice dial: recipientKind=owner|external|e164; draft-confirm; approval-queue
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (83 chars vs 508 chars — 84% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
