# Ori Master Bible (Soulmates)

Version: 0.1  
Last updated: 2026-01-18  
Owner: Product and Engineering  

## TL;DR
Ori delivers 1:1 community connections via WhatsApp, orchestrating meaningful offline meetings through adaptive, science-backed conversations with no app downloads. The platform manages matching, logistics, and trust-building through seamless messaging, incremental insights, and delightful feedback loops, targeting users seeking belonging without digital clutter, and communities aiming to foster real engagement.

## Goals

### Business Goals
- Achieve 30 percent or higher rate of users scheduling a second meeting
- Reach 60 percent Day 7 and 40 percent Day 30 retention among initial cohorts
- Realize 85 percent completion rate for scheduled meetings
- Attain 70 percent or higher positive qualitative meeting feedback
- Establish community partner satisfaction with measurable engagement reports

### User Goals
- Relieve app fatigue with frictionless entry via WhatsApp
- Maximize trust and safety with curated matches and clear support
- Spark curiosity and discovery in new connections
- Sense of belonging through recurring rituals
- Enjoy seamless logistics and reminders

### Non-Goals
- Build a custom mobile app
- Add metrics or leaderboard gamification for users
- Create public profiles or a community browsing directory

## Personas and User Stories

### Community Member Seeking Connections
- Sign up with just email or phone number to start quickly
- Receive Ori check-ins via WhatsApp for a warm, approachable experience
- Get matched 1:1 with relevant peers for meaningful meetings
- Use simple logistics and reminders with minimal planning effort
- Provide feedback after meetings to improve future matches

### Program Partner Admin
- Invite members and monitor participation and retention
- Receive alerts for onboarding drop-off and safety issues
- View aggregate insights on meeting outcomes for reporting

## Product Principles
- Conversational, not transactional
- Variable, not predictable
- Reciprocal value exchange: user data gets immediate insight
- Ritual, not gamified
- Mysterious, not obvious
- Educational, not manipulative
- Respectful, not needy
- Safety and trust are always one tap away

## End-to-End User Lifecycle

1. Discovery and Entry
   - Entry via community invite and a WhatsApp-first message
   - Optionally begins from a Next.js landing page that collects name and location
2. Identity and Consent
   - WhatsApp consent, privacy statement, opt-in, and identity verification
3. Initial Onboarding and 7D Profile Capture
   - Conversational questions, short and spaced
   - Explicit explanation of how Ori works and what to expect
4. First Group Meeting for Network Validation
   - User joins a group meeting to validate behavior and gain human reviews
5. Matching Queue
   - User enters active matching pool with reliability weighting
6. Match Discovery and Staged Reveal
   - Ori builds anticipation, then reveals details in phases
7. Scheduling and Logistics
   - Ori proposes a time and handles rescheduling
8. Meeting Support and Reminders
   - Automated T-24h and T-2h reminders, late arrival handling
9. Feedback and Repeat Meeting Loop
   - Post-meeting feedback and repeat meeting offer when mutual
10. Progressive Profiling and Insight Delivery
   - Ongoing questions and science-backed insights
11. Re-engagement or Pause
   - Graduated reactivation and user-controlled pause
12. Safety and Escalation
   - Block, report, and emergency escalation are always available

## WhatsApp Experience Flows

### Initial Onboarding
- Ori invites the user and asks for consent
- Ori confirms name and pronouns
- Ori captures time zone and typical availability
- Ori collects interests and desired cadence
- Ori confirms safety and conduct with explicit consent

### Scheduled Check-Ins
- "Hi [Name], ready to meet someone new from [Community]?"
- YES: start matching
- NO: ask to skip cycle or pause for a month
- LATER: set a follow-up time
- No reply after 24h: gentle reminder
- No reply after 7 days: pause and offer reactivation

### Staged Match Reveal
- Phase 1: Found someone who shares [Interest]
- Phase 2: Availability alignment and time window
- Phase 3: Offer group chat introduction
- Phase 4: Scheduling proposal with concrete time

### Scheduling and Reminders
- Ori proposes one default time based on overlap
- Supports up to three back-and-forth suggestions
- Falls back to admin if not scheduled within 72 hours
- Reminders at T-24h and T-2h with MOVE and CANCEL options

### Cancellation Handling
- First cancellation: understanding response and rematch
- Repeated cancellations: cool-off period and lower priority
- Last-minute cancellation: friction prompt with explicit confirmation

### Post-Meeting Feedback
- Prompt for completion, quality rating, and meet-again intent
- Negative response triggers block and follow-up question
- Strong positive response triggers repeat scheduling

### Safety and Emergency
- "FLAG" for support
- "RED" for emergency with immediate escalation
- User receives local support resources and safety check-in

## 7D Profile Model

Ori stores exactly seven profile dimensions that evolve over time:

1. Name and pronouns
2. Time zone and typical weekly availability
3. General interests (from dynamic prompt lists)
4. Desired meeting cadence
5. Past feedback sentiment with structured and freeform notes
6. Connection goals (inspiration, accountability, growth)
7. Community-specific affinity tags (optional)

Collection is gradual and conversational. Example:
"What is one thing you are hoping to talk about next time?"

## Domain Modes

Ori supports multiple matching domains that share the 7D core:
- General: default community matching
- Business: mentorship and professional networking
- Love: dating and romantic matches
- Friendship: social and community ties

Domain selection influences prompt tone, match rules, and safety guardrails.

## Matching Logic

### Hard Constraints
- Block lists are mutual and immediate
- Availability must include at least one 2-hour overlap within 7 days
- At least one shared interest
- Interest differential capped at 40 percent dissimilarity by affinity scoring
- No repeat matches within a rolling 8-meeting window
- Negative feedback on a user blocks rematching for 6 months
- Strong negative feedback on a topic reduces similar matches
- Admin curated lists can override weighting for program goals

### Scoring and Weighting
- Base similarity score from 7D profile overlap
- Reliability score weighs higher for users who were ghosted or canceled on
- LLM-based compatibility scoring on top of heuristic filters
- Preference adjustments based on explicit feedback

### Matching Cadence
- Nightly matching for opted-in users
- Instant matching on explicit YES to check-in
- Match backlog visible to admin for manual overrides

## Scheduling Logic

1. Normalize availability to time zone
2. Generate candidate windows for the next 7 days
3. Propose the earliest viable slot
4. Allow three counter-proposals per pair
5. Escalate to admin at 72 hours without agreement

Calendars are optional for MVP, with manual or automated holds when integrated.

## Reliability and Integrity Scoring

Reliability score is not visible to users and includes:
- Attendance history
- Late cancellations
- Ghosting or non-response
- Meeting completion confirmations

Rules:
- Two consecutive last-minute cancels or three cancels in a 5 match window reduce priority
- Repeated ghosting triggers cool-off and coaching flow

## Safety and Moderation

### Blocks
- User can block a match directly in chat
- Block is mutual and takes effect immediately

### Reporting Levels
- Level 1: Discomfort, stored for pattern detection
- Level 2: Explicit report, immediate admin notification, user removed from matching
- Level 3: Emergency, instant escalation with transcript and contact info

### User Guidance
- Safety reminders pre-meeting
- Public venue preference
- Always-available help keyword

## System Architecture

### Entry Points
- WhatsApp via Twilio webhook
- Next.js landing page for name and location capture
- Email and SMS onboarding link to WhatsApp

### Core Services
- Agent runtime: `examples/soulmates/agent.ts`
- Character style and system prompt: `examples/soulmates/character.ts`
- Conversational intake form: `examples/soulmates/soulmates-form.ts`
- Next.js lander: `examples/soulmates/app`
- Database persistence via `@elizaos/plugin-sql`

### Services to Implement
- Matching engine with nightly batch and on-demand match flow
- Scheduling engine with time zone normalization
- Notification scheduler for check-ins and reminders
- Safety escalation service for reports and emergencies
- Admin dashboard and reporting export
- Stripe payments and credit ledger
- Location and distance engine for in-person constraints
- Insight library and delivery engine

## Data Model (Conceptual)

### User
- id, phone, email, status, consent timestamps
- community id, domain, created at

### Profile
- 7D core fields
- domain-specific extensions
- progressive insight notes

### Availability
- time zone, weekly windows, exceptions

### Match
- user A, user B, match score, match reasoning
- created at, status, scheduled meeting id

### Meeting
- time, location, status, reminder state
- reschedule count, cancellation reason

### Feedback
- rating, sentiment, meet-again decision
- notes, safety flags

### Safety Report
- type, severity, transcript reference, status

### Reliability
- score, last updated, cancellation history

### Community and Program
- partner id, settings, cadence rules, admin users

### Payments and Credits
- credit balance, ledger entries, Stripe ids
- pricing experiments and purchase events

### Messaging
- inbound and outbound message logs
- delivery status and latency metrics

## Matching Engine Details

### Candidate Filtering
- Domain alignment and eligibility
- Location and distance within city
- Age, gender, orientation constraints for dating
- Block list and feedback exclusions
- Availability overlap requirement

### Scoring
- Interest overlap and affinity similarity
- Cadence alignment
- Trust and reliability score
- LLM-based compatibility evaluation

### Result Selection
- Top ranked matches with fairness constraints
- Avoid repeats for a rolling 8-meeting window
- Admin override list for strategic programs

## Scheduling Engine Details

### Inputs
- Availability windows
- Time zone and local time preferences
- Location preferences for in-person meetings

### Outputs
- Concrete proposed slot
- Automatic reminders
- Escalation when scheduling fails

## Payment and Credit System

### Principles
- No pay-to-play messaging
- Credits cover premium matching and scheduling costs
- Transparent pricing discovery in onboarding

### Credit Uses
- Prioritized matching in queue
- Time-specific scheduling
- Expanded filters
- Additional insight requests

### Ledger
- Every credit purchase and spend is logged with timestamps and reason

## Notifications and Job Scheduling

### Cadence Types
- Daily or weekly check-ins with variable timing
- Reminders at T-24h and T-2h
- Re-engagement after inactivity

### Implementation
- Cron-based scheduler or queue-driven jobs
- Quiet hours by time zone
- Message delivery monitoring and retries

## Admin Dashboard

### Admin Needs
- Invite management and cohort stats
- Match pipeline visibility
- Safety incident review
- Cancellation and reliability dashboards
- Exportable reports for partners

### Interfaces
- Web dashboard for admins only
- Role-based access controls

## Analytics and Metrics

### Primary KPIs
- Repeat meeting rate
- Day 7 and Day 30 retention
- Meeting completion rate
- Positive feedback rate
- Partner NPS and satisfaction

### Event Tracking
- Onboarding started and completed
- Check-in participation
- Match created and confirmed
- Meeting scheduled and completed
- Reminder engagement
- Feedback submitted
- Cancellation and escalation events

## Simulation and Testing

### Profile Generation
- Generate 100 synthetic personas using `engine/schema/persona.schema.json`
- Include NY and SF as initial locations

### Match Matrix
- Use `engine/schema/match-matrix.schema.json` to store simulated scores
- Validate against `engine/schema/benchmarks.schema.json`

### Simulation Scenarios
- Ghosting behavior
- Late cancellations
- Red flag events
- Reliability weighting adjustments

## Roadmap

### MVP
- WhatsApp onboarding and check-ins
- 7D profile capture
- Matching and scheduling engine
- Safety flow
- Post-meeting feedback
- Admin dashboard basics

### Next
- Staged reveal variations
- Insight library expansion
- Repeat meeting coordination
- More robust re-engagement

### Later
- ML-based profile refinement
- Complementary matching
- Referral mechanics
- Advanced analytics and forecasting

## Open Decisions

### Data Strategy
- Final storage schema for 7D profile history
- LLM prompt sets for compatibility scoring

### Product
- Pricing for credit bundles
- Frequency of check-ins per community

## Current Implementation References
- `examples/soulmates/agent.ts` for Twilio agent runtime
- `examples/soulmates/character.ts` for Ori style guide
- `examples/soulmates/soulmates-form.ts` for intake form
- `examples/soulmates/app` for landing page
