REMOTE_DESKTOP parameter typing rationale (2026-05-10):
- `subaction` enum mirrors `RemoteSubaction` literal union and the SUBACTIONS map.
- `pairingCode` gets `^[0-9]{6}$` pattern — RemoteSessionService rejects anything else and the description already specified 6 digits.
- No top-level required fields: per-subaction `required` lives in the SUBACTIONS map (handler uses `resolveActionArgs` which surfaces clarifications). Marking `confirmed` required would force every read-only subaction (status/list) to also send confirmed=true, which would be wrong.
