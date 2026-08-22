# macOS EventKit provenance contract

Owner: macOS reconciliation lane

Consumer: `@elizaos/plugin-calendar` Apple normalization and unified-feed deduplication

Native file intentionally untouched: `packages/app-core/platforms/electrobun/native/macos/window-effects.mm`

## Required event JSON additions

The dictionary returned by the existing `elizaEventJson(EKEvent *)` boundary must add these fields without renaming or removing current fields:

| JSON field | EventKit source | Null/empty behavior |
| --- | --- | --- |
| `iCalUID` | `calendarItemExternalIdentifier` | JSON null when unavailable |
| `originalStartAt` | `occurrenceDate`, ISO-8601 UTC | JSON null for non-occurrences |
| `lastModifiedAt` | `lastModifiedDate`, ISO-8601 UTC | JSON null when unavailable |
| `recurrenceRules` | `recurrenceRules` | Array of `{ frequency, interval, occurrenceCount, endDate }`; empty array when none |
| `reminders` | `alarms` | Array of `{ relativeOffsetSeconds, absoluteDate, locationTitle }`; empty array when none |
| `sourceIdentifier` | `calendar.source.sourceIdentifier` | JSON null when unavailable |
| `sourceTitle` | `calendar.source.title` | JSON null when unavailable |
| `sourceType` | `calendar.source.sourceType` | `local`, `exchange`, `caldav`, `mobile_me`, `subscribed`, `birthdays`, or `unknown` |

The existing calendar dictionary must add `sourceIdentifier`, `sourceTitle`, and `sourceType` with the same mapping. No credentials, account identifiers, attendee addresses, descriptions, or titles may be logged as part of this change.

## Store-change signal

Expose a narrow change-generation or callback boundary backed by `EKEventStoreChangedNotification`. The Calendar service needs only a monotonically increasing generation or a notification callback; it does not need direct EventKit objects. A change invalidates Apple sync-state cache rows so the next bounded-window read reconciles additions, edits, cancellations, and deletions. It must not write or mirror any event.

## Acceptance expectations

- Rebuild `libMacWindowEffects.dylib` with `bun run --cwd packages/app-core/platforms/electrobun build:native-effects`.
- A Google recurring event surfaced through Apple must emit the same portable UID and original occurrence instant as the direct Google API event.
- `plugins/plugin-calendar/src/apple-calendar.provenance.test.ts` must continue to collapse the overlap to one Google-authoritative event with both provider sources retained in dedup metadata.
- A Calendar edit made in Apple Calendar must change the native generation/callback, invalidate the cached Apple sync state, and appear on the next bounded feed read without restarting Eliza.
- Denied/restricted permission and a source without portable UID must remain honest non-deduplicated states; never fall back to title/time matching.
