CALENDLY parameter typing rationale (2026-05-10):
The action is defined in `lib/calendly-handler.ts` (re-exported from
`lib/scheduling-handler.ts` as part of the calendly subaction surface).

- `subaction` enum mirrors the runtime `parseSubaction` switch (4 values).
- `startDate`/`endDate` get YYYY-MM-DD pattern.
- `eventTypeUri`, `timezone` stay free-form (Calendly URIs are opaque, IANA list too large).
- No required fields top-level: the handler validates per-subaction and returns specific error text when fields are missing.
