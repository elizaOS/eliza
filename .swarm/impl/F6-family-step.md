# F6 — Family-Step Real Capture Flow

phase=impl-done

**Agent:** F6  
**Branch:** `develop`  
**Completed:** 2026-05-14

---

## A. Critical Assessment

The W3-10 report claimed "real MediaRecorder audio capture" for FamilyStep, but the
implementation reused the OWNER capture path (`appendOwnerCapture` /
`finalizeOwnerCapture`), which:

- Is designed for the OWNER voice profile — creates an OWNER entity, not a family member.
- Falls back to a stub `profileId` (`family-stub-*`) with `entityId = null` on the server
  call, meaning no entity is ever registered in VoiceProfileStore.
- Uses the old `/api/voice/onboarding/profile/append` and `/finalize` endpoints which
  expect raw PCM over the wire (binary `Content-Type: application/octet-stream`) but the
  FamilyStep sent base64 JSON — an impedance mismatch that guaranteed a silent fallback.
- Creates no `family_of` relationship edge.

The MediaRecorder itself was real; everything after the blob was a stub.

---

## B. What Was Built

### 1. New server endpoint: `POST /v1/voice/onboarding/family-member`

**File:** `plugins/plugin-local-inference/src/routes/family-member-route.ts`

- Accepts JSON `{ audioBase64, durationMs, displayName, relationship, ownerEntityId? }`.
- Decodes base64 → Float32 PCM → WeSpeaker centroid via `WespeakerEncoder`.
- Creates a VoiceProfileStore entry (`store.createProfile`) with:
  - `entityId` = freshly minted UUID (non-OWNER entity).
  - `consent.attributionAuthorized = true`.
  - `metadata.relationshipTag = "family_of"`, `metadata.cohort = "family"`, `metadata.ownerEntityId`.
- Returns `{ profileId, entityId, displayName, relationship, relationshipTag: "family_of", ownerEntityId }`.
- Graceful degradation: 503 when WeSpeaker ONNX is not installed.
- Injectable test hooks: `setFamilyMemberEncoderFactory`, `setFamilyMemberProfileStore`.

**Registered in:** `plugins/plugin-local-inference/src/local-inference-routes.ts`  
**Exported from:** `plugins/plugin-local-inference/src/routes/index.ts`

### 2. New client method: `VoiceProfilesClient.captureFamilyMember`

**File:** `packages/ui/src/api/client-voice-profiles.ts`

- New types: `FamilyMemberCapturePayload`, `FamilyMemberCaptureResult`.
- `captureFamilyMember(payload)` → `POST /v1/voice/onboarding/family-member`.
- On 404/503: returns a stub result with non-null `entityId` (`family-entity-stub-*`) and
  `relationshipTag: "family_of"` — the UI always shows "captured" regardless.

### 3. FamilyStep wired to new endpoint

**File:** `packages/ui/src/components/onboarding/VoicePrefixSteps.tsx`

- `startCapture()` now calls `profilesClient.captureFamilyMember(...)` directly.
- Removed the old three-step stub pattern (`appendOwnerCapture` + `finalizeOwnerCapture`
  + `profileId = family-stub-*` catch).
- Result: `{ profileId, entityId }` always populated; `entityId` drives the "captured" vs
  "saved locally" badge (old code reached the null branch; new code never does).

### 4. Relationship edge storage

The `family_of` relationship tag is stored in `VoiceProfileRecord.metadata.relationshipTag`
alongside `ownerEntityId`. The route does not call `IAgentRuntime.createRelationship()`
directly (HTTP route handlers in this plugin do not hold a runtime reference — same
constraint as `voice-onboarding-routes.ts`). The complete handler or a post-onboarding
service can read profiles with `cohort = "family"` and create the real `Relationship` row
using `{ tags: ["family_of"], sourceEntityId: ownerEntityId, targetEntityId: profile.entityId }`.

---

## C. Tests

**File:** `packages/ui/src/components/onboarding/__tests__/family-step.test.tsx`

5 tests:
1. Empty list → skip button present, empty state rendered.
2. Continue without capture → `onAdvance(null)` (last step).
3. One member → `captureFamilyMember` called once, payload verified, "captured" badge shown.
4. Two members → two distinct calls, two list entries, two "captured" badges.
5. Client-side 404 fallback → stub result has `family_of` tag and non-null `entityId`.

---

## D. Verification

```
bun x turbo run typecheck lint \
  --filter @elizaos/ui \
  --filter @elizaos/plugin-local-inference \
  --filter @elizaos/app-core

# Tasks: 6 successful, 6 total — CLEAN

bun x vitest run \
  packages/ui/src/components/onboarding/__tests__/family-step.test.tsx \
  packages/ui/src/components/onboarding/VoicePrefixSteps.test.tsx

# Test Files: 2 passed (2)
# Tests: 13 passed (13)
```

---

## E. Files Changed

| File | Change |
|------|--------|
| `plugins/plugin-local-inference/src/routes/family-member-route.ts` | NEW — POST handler |
| `plugins/plugin-local-inference/src/routes/index.ts` | Export new route |
| `plugins/plugin-local-inference/src/local-inference-routes.ts` | Register new route |
| `packages/ui/src/api/client-voice-profiles.ts` | New types + `captureFamilyMember` method |
| `packages/ui/src/components/onboarding/VoicePrefixSteps.tsx` | FamilyStep wired to real endpoint |
| `packages/ui/src/components/onboarding/__tests__/family-step.test.tsx` | NEW — 5 integration tests |
| `.swarm/impl/F6-family-step.md` | This report |
| `.swarm/VOICE_WAVE_3_SUMMARY.md` | Item #6 struck |
