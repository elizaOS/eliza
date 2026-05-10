BOOK_TRAVEL parameter typing rationale (2026-05-10):
- `origin`/`destination` get IATA pattern (`^[A-Z]{3}$`) so external agents emit valid codes; non-IATA inputs would fail downstream Duffel calls anyway.
- `departureDate`/`returnDate` get YYYY-MM-DD pattern.
- `offerId` gets Duffel pattern (`^off_...`) — matches Duffel's actual offer-id format.
- `passengers` array now has fully typed item schema with required `givenName/familyName/bornOn/gender` (Duffel CreateOrder requires these). `gender` enum reflects what the Duffel API accepts (m|f only).
- `calendarSync` object schema documents the actual shape consumed by the calendar-sync side-effect (calendarId, attendees, notes).
- No top-level field marked required: BOOK_TRAVEL is dual-mode — either an `offerId` is supplied to confirm an existing search, or origin/destination/departureDate trigger a fresh search. Marking either set required would break the other path.
