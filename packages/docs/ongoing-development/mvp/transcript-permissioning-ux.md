# Transcript Permissioning UX

Issue: [#14782](https://github.com/elizaOS/eliza/issues/14782)

## Journey

The transcript journey is one artifact with role-shaped disclosure:

1. A voice or meeting capture creates an owner-private transcript row.
2. The chat attachment opens the transcript overlay and shows a visible privacy
   badge: `Private`, `Redacted`, or `Global`.
3. `Share` opens an in-app access sheet, not the platform share sheet. The sheet
   defaults to `Redacted`; `Full` is visible only to admin-tier callers.
4. A redacted grant creates or refreshes the linked redacted variant, then writes
   the recipient grant on the original row. The recipient still addresses the
   original transcript id, but the server serves the redacted variant with audio
   withheld.
5. `Revoke` removes the selected recipient grant from the original row. It does
   not delete copies already exported outside elizaOS, and it does not delete the
   redacted variant row.
6. A redacted viewer cannot re-share, edit, delete, or revoke access. The
   server enforces this even if a client sends the request, and the overlay
   renders the redacted view as read-only.

## Simplification Inventory

Current transcript affordances and their intended ownership:

| Affordance | Owner | Decision |
| --- | --- | --- |
| Inline audio playback | Transcript overlay | Keep; recording-specific download/share stays beside the player. |
| Copy transcript text | Transcript overlay | Keep as a local clipboard operation with explicit failure state. |
| Download transcript markdown | Transcript overlay | Keep as local export; it is outside grant revocation once saved. |
| Share transcript text via Web Share | None | Retire as the primary `Share`; transcript sharing now means elizaOS access grants. |
| Share recording via Web Share | Audio player controls | Keep; it exports source audio and is separate from transcript access grants. |
| Edit transcript text | Transcript overlay | Keep for full/private records; hide in redacted views and reject redacted-view route calls. |
| Delete transcript | Transcript overlay | Keep as destructive owner/admin record management; hide in redacted views and reject redacted-view route calls. |
| `TRANSCRIPT_MARKER` id round-trip | Chat attachment fallback | Temporary compatibility only; retire when chat attachments always carry the Files-surface artifact id. |
| Share sheet recipient picker | Transcript overlay | First slice accepts an entity id; the target design is a roster/contact picker sourced from room membership plus connector contacts. |
| Share/revoke backend | Transcript routes | Added as transcript routes so the UI calls the same artifact-disclosure store used by actions. |

## States To Verify

- Loading: spinner, no empty transcript claim.
- Empty: only when a loaded transcript has no text.
- Error: failed record/inline load renders a visible error.
- Private full view: `Private` badge, Share enabled, redacted mode default.
- Redacted view: `Redacted` badge, audio absent, Share disabled, edit/delete hidden, route rejects re-share/edit/delete.
- Admin full-share path: `Full` option visible under `RoleGate`, route rejects full share below ADMIN.
- Revoke path: grant removed, recipient GET becomes 404.
- Mobile keyboard: recipient field remains inside the scrollable overlay body; footer stays reachable after scrolling.
