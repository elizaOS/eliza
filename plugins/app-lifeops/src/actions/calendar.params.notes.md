CALENDAR parameter typing rationale (2026-05-10):
- Existing top-level params already had typed enum on `subaction`. The big gap was `details` being `{ type: "object" }` with no properties — non-Eliza agents had no way to know what nested keys to send.
- Added typed `details.properties` keyed off `CALENDAR_DETAIL_ALIASES` canonical names (calendarId, timeMin, timeMax, timeZone, startAt, endAt, durationMinutes, eventId, newTitle, description, location, travelOriginAddress, windowDays, windowPreset, forceSync, attendees).
- Did NOT mark any nested `details` field required: which fields apply depends entirely on subaction (eventId for delete/update, calendarId for feed-by-cal, etc.) and the handler routes through `normalizeCalendarDetails` + per-subaction validators.
- `descriptionCompressed` lists the keys flat for prompt-cache compactness.
