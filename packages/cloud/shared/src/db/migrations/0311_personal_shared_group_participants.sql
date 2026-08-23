-- Per-binding participant identity registry for Personal Shared group chats.
--
-- The model-facing speaker label used to be `<name> [participant <8 hex>]`,
-- where the hex was a truncated SHA-256 of the connector handle. Blooio
-- (iMessage) never sends a display name, so on that connector every speaker
-- was literally `Participant [participant 0da02073]`: the model could not tell
-- two people apart, and when it echoed the label the raw digest reached the
-- group. A high-entropy token is both unsafe to repeat and impossible to
-- enumerate, so nothing downstream could recognise or sanitise it.
--
-- This table replaces the digest with a stable per-binding ordinal assigned in
-- first-seen order, so the label reads as ordinary language (`Participant 3`)
-- and every participant of a binding is enumerable server-side.
--
-- `platform_user_id` is the raw connector handle (a phone number on Blooio, a
-- numeric id on Telegram). It is the join key that makes the roster
-- enumerable and is what the outbound redaction guard matches against; it
-- must never reach the model. The owner's handle is already stored on
-- personal_shared_group_bindings.created_by_platform_user_id, so this is the
-- same class of data behind the same tenant boundary, not a new exposure.
--
-- `display_name` holds the name the connector supplied for this participant,
-- when it supplied one and it survived the resolution rules in
-- lib/services/shared-runtime/group-participant-labels.ts: it must not forge
-- prompt structure, impersonate a generated label or the owner destination
-- label, carry any participant's connector handle, or duplicate a name another
-- participant of this binding already holds. Every rejection falls back to the
-- ordinal, which is why the column is nullable and why the label is
-- `display_name ?? 'Participant ' || ordinal`. Blooio sends no names, so those
-- rooms are all ordinals; Telegram and Discord do, so those keep real names.
-- A future name source (the owner's contacts, the entity graph) writes the
-- same column under the same rules.

CREATE TABLE IF NOT EXISTS personal_shared_group_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL REFERENCES personal_shared_group_bindings(id) ON DELETE CASCADE,
  platform_user_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  display_name text CHECK (
    display_name IS NULL OR (length(display_name) > 0 AND length(display_name) <= 128)
  ),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE personal_shared_group_participants IS
  'Model-facing identity for the speakers of one bound provider group. The ordinal is the label the model reads; platform_user_id is server-side only and must never be rendered into a prompt or a reply.';
COMMENT ON COLUMN personal_shared_group_participants.ordinal IS
  '1-based, assigned in first-seen order within a binding. Stable for the life of the binding: a participant keeps the same ordinal across turns, so history stays readable.';
COMMENT ON COLUMN personal_shared_group_participants.display_name IS
  'Connector-supplied name that passed the resolution rules, or NULL when none was supplied or it was rejected. Never trust it raw: it is attacker-controlled on every connector that sends one.';

-- The registration key: one row per (binding, connector handle). Also the
-- conflict target the repository claims against.
CREATE UNIQUE INDEX IF NOT EXISTS personal_shared_group_participants_actor_uidx
  ON personal_shared_group_participants (binding_id, platform_user_id);
-- Two participants speaking at once must not both take ordinal N. The
-- repository serializes assignment on a per-binding advisory lock; this index
-- is the schema-level backstop that makes a duplicate impossible to persist.
CREATE UNIQUE INDEX IF NOT EXISTS personal_shared_group_participants_ordinal_uidx
  ON personal_shared_group_participants (binding_id, ordinal);
