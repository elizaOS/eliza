# Soulmates App (Next.js)

Soulmates landing page and member dashboard built on Next.js with:

- Phone-based auth via NextAuth + Twilio Verify
- Admin dashboard for member operations
- Stripe credit topup system
- System-aware light/dark theme

## Quick Start

```bash
cd examples/soulmates/app
bun install
bun run dev
```

Open http://localhost:3000

## Environment

Create a `.env` file with the following:

### Required

- `NEXTAUTH_SECRET` - random string for session signing (generate with `openssl rand -base64 32`)
- `NEXT_PUBLIC_ORI_PHONE_NUMBER` - Ori's Twilio phone number in E.164 format (e.g., `+15551234567`)
- `TWILIO_ACCOUNT_SID` - Twilio account SID
- `TWILIO_AUTH_TOKEN` - Twilio auth token
- `TWILIO_VERIFY_SERVICE_SID` - Twilio Verify service SID (create one in Twilio console)
- `STRIPE_SECRET_KEY` - Stripe secret key
- `STRIPE_WEBHOOK_SECRET` - Stripe webhook signing secret

### Admin Setup

- `SOULMATES_ADMIN_PHONES` - comma-separated E.164 phone numbers for admin access
Members are active by default; use admin actions to block accounts when needed.

### Database

- `POSTGRES_URL` - PostgreSQL connection string (optional, uses PGlite if not set)
- `PGLITE_DATA_DIR` - PGlite data directory (default: `./data/pglite`)

### Optional

- `DEV_LOGIN_ENABLED=true` - enable dev login bypass (server-side)
- `DEV_LOGIN_PHONE=+15555550100` - phone number used for dev login
- `NEXT_PUBLIC_DEV_LOGIN_ENABLED=true` - show the dev login button in UI
- `NEXTAUTH_URL` - required for production deployments (e.g., `https://soulmates.example.com`)
- `SOULMATES_CRON_SECRET` - shared secret for cron endpoints
- `SOULMATES_ENGINE_INGEST_SECRET` - shared secret for persona sync API
- `TWILIO_MESSAGING_SERVICE_SID` - Twilio Messaging Service for outbound SMS
- `SOULMATES_MATCHING_NOTIFY=true` - send match notifications
- `SOULMATES_MATCHING_CHANNEL=sms|whatsapp` - outbound channel for match notifications
- `SOULMATES_MATCHING_LLM_MODE=none|heuristic|openai` - LLM provider mode
- `SOULMATES_MATCHING_OPENAI_MODEL` - OpenAI model override (default: gpt-4o-mini)
- `OPENAI_API_KEY` - required if using OpenAI LLM mode
- `SOULMATES_MATCHING_BATCH_SIZE` - personas per tick (default: 25)
- `SOULMATES_MATCHING_MAX_TICKS` - max ticks per cron run (default: 6)
- `SOULMATES_MATCHING_CRON_MAX_MS` - max runtime per cron (default: 4 minutes)
- `SOULMATES_MATCHING_LOCK_MS` - lock duration for cron runs
- `SOULMATES_MATCHING_MAX_CANDIDATES` - candidate pool size (default: 60)
- `SOULMATES_MATCHING_SMALL_TOPK` - small pass top K (default: 12)
- `SOULMATES_MATCHING_LARGE_TOPK` - large pass top K (default: 6)
- `SOULMATES_MATCHING_GRAPH_HOPS` - graph hop depth (default: 2)
- `SOULMATES_MATCHING_COOLDOWN_DAYS` - match cooldown window
- `SOULMATES_MATCHING_MIN_AVAIL_MIN` - minimum overlap minutes
- `SOULMATES_MATCHING_RELIABILITY_WEIGHT` - reliability weight multiplier
- `SOULMATES_MATCH_DOMAINS` - comma-separated domains to match
- `SOULMATES_DEFAULT_DOMAINS` - default domains if none configured
- `SOULMATES_MATCHING_AUTO_SCHEDULE=true` - auto-propose meeting slots
- `SOULMATES_MATCH_REQUIRE_SAME_CITY=true` - require same city
- `SOULMATES_MATCH_REQUIRE_SHARED_INTERESTS=true` - require shared interests
- `SOULMATES_REMINDERS_ENABLED=true` - enable reminder cron
- `SOULMATES_REMINDER_CHANNEL=sms|whatsapp` - outbound channel for reminders
- `SOULMATES_REMINDER_WINDOWS_MINUTES` - comma-separated reminder offsets (default: 1440,120)
- `SOULMATES_REMINDER_TOLERANCE_MINUTES` - reminder window tolerance (default: 10)
- `SOULMATES_REMINDERS_LOCK_MS` - lock duration for reminder cron
- `SOULMATES_MATCH_REVEAL_PHASE2_HOURS` - hours after phase 1 to send phase 2
- `SOULMATES_MATCH_REVEAL_PHASE3_HOURS` - hours after phase 2 to send phase 3
- `SOULMATES_MATCH_REVEAL_PHASE4_HOURS` - hours after phase 3 to send phase 4
- `SOULMATES_CHECKIN_PAUSE_DAYS` - pause duration after check-in (default: 30)
- `SOULMATES_MAX_RESCHEDULES` - max reschedule attempts before admin escalation (default: 3)
- `SOULMATES_PRIORITY_MATCH_WINDOW_HOURS` - priority match spend window (default: 24)

### Group Meeting Configuration
- `SOULMATES_GROUP_MEETING_ISO` - ISO datetime for next group meeting (e.g., `2026-02-01T18:00:00Z`)
- `SOULMATES_GROUP_MEETING_LOCATION_NAME` - group meeting venue name
- `SOULMATES_GROUP_MEETING_LOCATION_ADDRESS` - group meeting venue address
- `SOULMATES_GROUP_FEEDBACK_DELAY_HOURS` - hours after group meeting to request feedback (default: 2)

### Reliability Coaching
- `SOULMATES_LOW_RELIABILITY_THRESHOLD` - reliability score threshold for coaching (default: 60)
- `SOULMATES_RELIABILITY_COACHING_DAYS` - days between coaching messages (default: 14)
- `SOULMATES_RELIABILITY_COOLOFF_DAYS` - cool-off period for poor reliability (default: 7)

### Reactivation
- `SOULMATES_DORMANT_DAYS` - days of inactivity before reactivation attempts (default: 14)
- `SOULMATES_REACTIVATION_INTERVAL_DAYS` - days between reactivation attempts (default: 7)
- `SOULMATES_MAX_REACTIVATION_ATTEMPTS` - max reactivation attempts before pause (default: 3)

### Messaging & Timing
- `SOULMATES_QUIET_START_HOUR` - start of quiet hours (default: 22 for 10pm)
- `SOULMATES_QUIET_END_HOUR` - end of quiet hours (default: 8 for 8am)
- `SOULMATES_CHECKIN_JITTER_HOURS` - timing variability for check-ins (default: 2)
- `SOULMATES_MATCH_REVEAL_EXPIRE_HOURS` - hours before unresponded match expires (default: 48)

## Cron Scheduling (Vercel)

The app includes a `vercel.json` file that schedules nightly matching and reminders:

- `/api/cron/matching` at 02:00 UTC
- `/api/cron/reminders` at 02:30 UTC

If you deploy outside Vercel, wire these endpoints in your scheduler of choice and pass `SOULMATES_CRON_SECRET`.
- `SOULMATES_ENGINE_INGEST_LOCK_MS` - lock duration for persona sync
- `SOULMATES_MATCH_ACTION_LOCK_MS` - lock duration for match updates

## Architecture

```
/                   - Landing page with SMS connect
/login              - Phone number verification
/app                - Member dashboard (protected)
/app/profile        - Edit profile
/app/billing        - Credit topup via Stripe
/app/admin          - Admin dashboard (users, matches, safety, exports)
/qr                 - QR code fallback for SMS link
```

## Data Storage

Uses a proper database backend:

- **Development**: PGlite (embedded PostgreSQL) at `./data/pglite`
- **Production**: PostgreSQL via `POSTGRES_URL` env var

The database schema includes:
- `soulmates_users` - user accounts and profiles
- `soulmates_credit_ledger` - credit transaction history
- `soulmates_rate_limits` - rate limiting counters

Tables are auto-created on first connection.

## Testing

```bash
# Run tests once
bun run test

# Watch mode
bun run test:watch
```

## Notes

- The lander uses `sms:` deep links to open Messages on Apple devices.
- Rate limiting is applied to the SMS verification endpoint (5 req/min per IP, 3 req/min per phone).
- The middleware protects all `/app/*` routes and redirects unauthenticated users to `/login`.
