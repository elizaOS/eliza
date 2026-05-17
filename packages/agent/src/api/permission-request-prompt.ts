/**
 * System-prompt fragment documenting the `permission_request` action block.
 *
 * Lives next to the canonical action-block parser so emissions and
 * documentation stay in sync. Imported into the swarm coordinator prompt and
 * (optionally) the chat coordinator's character system block so the planner
 * knows when — and crucially, when NOT — to emit a `permission_request`.
 *
 * Hard rules:
 *   - Emit ONLY when the user just asked for something AND the latest
 *     tool/action result returned `{ ok: false, reason: 'permission',
 *     permission: <id> }`.
 *   - NEVER preemptively. NEVER for permissions surfaced in `pending()` unless
 *     the user just touched a feature that needs that permission.
 *   - NEVER if the user already declined this permission in the last hour for
 *     the same feature.
 */

export const PERMISSION_REQUEST_PROMPT_FRAGMENT = `permission_request — REQUEST a system-level permission inline in chat.

Use ONLY when both of these are true:
  1. The user just asked for something that requires a permission, AND
  2. The most recent tool/action result returned a permission failure
     (e.g. { ok: false, reason: "permission", permission: "<id>" }).

Do NOT emit:
  - preemptively, before the user touches a permission-gated feature
  - for permissions you saw in PENDING PERMISSIONS unless the user just
    asked for a feature that needs that exact permission
  - if the user already declined this permission in the last hour for the
    same feature

Required fields:
  - permission: one of accessibility | screen-recording | reminders |
    calendar | health | screentime | contacts | notes | microphone |
    camera | location | shell | website-blocking | notifications |
    full-disk | automation
  - reason: short, user-facing, names the actual thing they asked for
    (e.g. "Add 'pick up groceries' to your Apple Reminders.")
  - feature: dotted "<app>.<area>.<action>" identifier
    (e.g. "lifeops.reminders.create")

Optional:
  - fallback_offered: true ONLY when a real fallback exists
  - fallback_label: button label for the fallback (required when
    fallback_offered === true)

Example:
  {"action":"permission_request","reasoning":"reminders denied for create",
   "permission":"reminders",
   "reason":"I'd like to add 'pick up groceries' to your Apple Reminders.",
   "feature":"lifeops.reminders.create",
   "fallback_offered":true,
   "fallback_label":"Use internal reminders instead"}`;
