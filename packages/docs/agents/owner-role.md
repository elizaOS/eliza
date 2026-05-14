---
title: "OWNER role"
description: "What it means to be the OWNER of an Eliza device, what privileges it grants, and how it's bound to your voice."
---

# OWNER role

Every Eliza device has exactly one **OWNER**. The OWNER is the person who
set up the device during onboarding — by default, that's you.

The OWNER role is bound to your **Entity** in the runtime's
entity/relationship system, persisted in the `ELIZA_ADMIN_ENTITY_ID`
setting, and enforced anywhere the runtime performs a permission check.

## What OWNER unlocks

- **Privileged actions** — the runtime will only execute administrative
  actions for the OWNER. That includes installing apps, granting
  permissions to other entities, configuring providers, exporting
  trajectories, and any action a plugin marks as
  `requiresRole: "OWNER"`.
- **Voice-bound authentication** — once your voice profile is captured
  during onboarding, the speaker-id pipeline matches every incoming
  utterance against that profile. Privileged actions only trigger when
  the speaker is recognised as the OWNER. If someone else picks up the
  device and asks for a system-level change, the agent will decline.
- **OWNER badge across the app** — you'll see a small crown icon next to
  your name in the shell header, in chat avatars, and in
  Settings → Voice → Profiles, so it's always clear which identity is
  active.

## How OWNER is established

OWNER is assigned during the **onboarding voice prefix** (Settings →
Voice if you skipped onboarding):

1. **Welcome + permissions.** Eliza asks for microphone access.
2. **Device check.** A hardware probe tells you whether your machine can
   run the full voice stack locally (MAX / GOOD / OKAY / POOR).
3. **Model download.** The voice bundle downloads in the background
   (skipped on POOR tier — voice is routed through Eliza Cloud).
4. **The agent talks to you.** A short scripted greeting plays in your
   chosen TTS voice.
5. **You talk to the agent.** Three short prompts capture your voice
   profile. About 60-90 seconds total.
6. **OWNER confirmation.** You see your captured display name + a Crown
   badge. Confirm to write `ELIZA_ADMIN_ENTITY_ID` to your device.
7. **Family members (optional).** You can introduce other people the
   agent might hear — those become non-OWNER profiles with relationship
   labels (`wife`, `colleague`, etc.).

## Transferring or revoking OWNER

OWNER is per-device. If you sign in on a new device, you go through the
voice prefix again — your new device gets its own OWNER entity, bound to
the same identity cluster as your existing devices via the runtime's
`identity_link` relationship tag.

To revoke OWNER:

- **Reset the device** — Settings → Backup & Reset → "Reset everything"
  clears `ELIZA_ADMIN_ENTITY_ID` and all voice profiles, then re-runs
  onboarding next launch.
- **Hand over to another person on the same device** — Settings → Voice
  → Profiles → (target row) → "Promote to OWNER". The new OWNER must
  complete a voice capture; the old OWNER is demoted to ADMIN unless you
  also delete their profile.

## Privacy

Voice profiles are biometric data. Eliza stores them locally under
`~/.milady/voice-profiles/` with strict file permissions. They are
**never** uploaded automatically — see Settings → Voice → Privacy for
the per-profile retention settings and the optional Eliza Cloud
first-line cache opt-in.

You can export your profile metadata at any time:
**Settings → Voice → Profiles → Export** writes a JSON blob of profile
names + relationship labels (no raw audio embeddings).

## Related runtime concepts

- `Role` enum — `OWNER | ADMIN | USER | GUEST`
  (`packages/core/src/types/environment.ts`).
- `ensureOwnerRole(entityId)` — server-side guard
  (`packages/agent/src/runtime/roles/src/index.ts`).
- Identity link — multi-device OWNER cluster
  (`getRelationships({tags: ["identity_link"]})`,
  `RelationshipsIdentityCluster.tsx`).
- Audit log — every privileged action by OWNER lands in
  `~/.milady/audit/owner-actions.jsonl`.
