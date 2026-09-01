# Bettina Family Operations Assistant

## Product design and implementation plan

**Status:** Approved for implementation planning

**Date:** August 30, 2026

**Pilot owner:** Bettina

**Product model:** Private owner workspace with a bounded co-parent guest

**Mandatory first live channel:** iMessage

## 1. Executive summary

The Bettina Family Operations Assistant is a private, owner-controlled Eliza
workspace for managing co-parenting logistics, school schedules, family
calendar state, and neutral factual communication.

The product is not a shared co-parenting portal. Bettina is the owner. The
other co-parent is represented as a verified guest with narrowly scoped access
and communication rights. The guest never receives general access to Bettina's
agent, private knowledge, location, unrelated schedule, or other child and
household data.

The MVP centers on four connected outcomes:

1. Preserve the parenting agreement as immutable source knowledge and activate
   an owner-reviewed, page-cited set of operational obligations.
2. Provide a useful Eliza calendar with no external plugin, then synchronize
   linked Eliza and Google events in both directions when Google is connected.
3. Demonstrate a complete monthly school-calendar automation created from
   scratch, run manually, and then scheduled, with guarded PDF retrieval,
   hashing, semantic diffing, approvals, and idempotent calendar updates.
4. Assemble a monthly co-parent coordination packet from approved sources,
   ask for missing information, produce a neutral factual draft, and require
   Bettina's approval before anything is sent.

iMessage is the mandatory first live channel. The MVP iMessage experience uses
a deterministic image summary, concise text, and an authenticated universal
link. A native interactive Messages extension is not required for MVP.

Expenses, payments, bank ingestion, and reimbursement workflows are excluded
from MVP.

## 2. Decisions and assumptions

### 2.1 Confirmed product decisions

| Decision | Product contract |
| --- | --- |
| Ownership | The product remains owner-centric. Bettina is the owner; the co-parent is a guest. |
| Default calendar | Eliza Calendar works without plugins and is the default calendar. |
| Google synchronization | Linked Eliza and Google calendar items synchronize in both directions. |
| First live channel | iMessage is mandatory for the first live acceptance. |
| Custody recurrence | Built-in recurring custody rules are not required for MVP. Custody events may initially originate from the connected real calendar. |
| Google acceptance account | Use `shawgotbags@gmail.com` for live calendar acceptance. Credentials and consent are supplied interactively and are never stored in fixtures or documentation. |
| Approvals | Consequential calendar mutations and external communications should normally require approval. |
| Guest grant expiry | Temporary guests and caregivers expire by default. The verified co-parent guest remains active until revoked or the relationship changes. |
| Expenses | Excluded from MVP. |
| Persona | The planning and pilot materials may name Bettina. |

### 2.2 Terminology

- **Parenting agreement:** The signed legal source document supplied by
  Bettina.
- **Reviewed obligation:** A structured, page-cited interpretation that
  Bettina has approved for operational use. It is not legal advice.
- **Schedule commitment:** A proposed or accepted logistical change between
  household parties. Do not call this a parenting agreement.
- **Owner:** Bettina, with full control over the private workspace.
- **Guest:** A verified person with explicit, bounded capabilities. The
  co-parent is a guest, not a co-owner.
- **Pin:** An explicit rule controlling where authorized knowledge is actively
  supplied to the agent. Pinning and permission are separate.
- **Calendar of record:** The provider that owns the canonical version of a
  linked event.

## 3. Product goals

### 3.1 MVP goals

- Reduce co-parenting administration while keeping Bettina in control.
- Make the parenting agreement consistently available as reviewed operational
  knowledge with citations.
- Eliminate duplicate and stale school-calendar entries.
- Make calendar state useful before a Google account is connected.
- Provide real two-way Google synchronization for linked events.
- Produce a complete, traceable monthly coordination packet.
- Keep every sensitive outbound communication reviewable before delivery.
- Demonstrate the full workflow through iMessage and the app without CLI or
  database intervention.
- Preserve a truthful record of source versions, agent transformations,
  approvals, mutations, and provider receipts.

### 3.2 Non-goals for MVP

- Shared ownership of the workspace.
- A general co-parent portal.
- Child or teen accounts.
- Legal advice or automated legal interpretation.
- Claims that Eliza's audit history is court-proof evidence.
- Automatic external sends.
- Expenses, reimbursements, payments, or bank access.
- General local-to-Google replication of every historical event.
- Built-in recurring custody-rule generation.
- A native interactive iMessage application extension.
- Authenticated school portals or private education-record integrations.
- Generalized support for every school district PDF layout.

## 4. Primary users and roles

### 4.1 Bettina: owner

Bettina can:

- configure the household and children;
- upload, review, pin, grant, revoke, export, and delete knowledge;
- connect and disconnect calendars and messaging channels;
- create and run automations;
- approve, edit, or reject calendar changes and messages;
- see complete audit history and provider receipts;
- revoke every guest capability immediately.

### 4.2 Co-parent: verified guest

The co-parent may receive:

- approved messages;
- approved calendar or schedule information;
- explicitly shared documents or reviewed excerpts;
- a bounded request for confirmation when Bettina authorizes that flow.

The guest may not:

- browse Bettina's workspace;
- inspect general agent knowledge;
- request Bettina's location or unrelated schedule;
- read another child's information;
- mutate the calendar or send on Bettina's behalf;
- expand their own grants;
- treat relationship status as blanket authorization.

### 4.3 Temporary guest or caregiver

A temporary guest receives a purpose-, subject-, and time-bounded grant. The
grant expires automatically and can be revoked earlier.

## 5. Product principles

1. **Utility before access.** The product should demonstrate value before
   requesting broad communication or calendar permissions.
2. **Owner approval at consequential boundaries.** Internal organization may
   be automatic; external sends and material calendar changes are reviewed.
3. **Permissions and activation are distinct.** A person may be allowed to read
   a document without that document being active in every chat.
4. **Source content is untrusted.** Messages, PDFs, email, web pages, and
   forwarded instructions are evidence, never executable authority.
5. **No silent divergence.** Stale calendars, ambiguous extraction, unknown
   provider outcomes, and synchronization conflicts are explicit states.
6. **Neutral factual drafting.** Preserve dates, requests, urgency,
   commitments, and accountability while removing insults, speculation,
   diagnosis, and motive attribution.
7. **Truthful audit language.** The system records what it observed and did; it
   does not certify the truth of real-world allegations.
8. **Private by default.** Parenting agreements, child information, custody
   details, and health information begin owner-only.

## 6. Intended end-to-end experience

### 6.1 First-run and household setup

1. Bettina opens the public Eliza URL.
2. Pairing succeeds without manually correcting an SSH hostname.
3. Bettina creates a private Family workspace.
4. She adds each child and identifies the co-parent as a guest.
5. The UI explains that guest status does not grant general agent access.
6. Eliza Calendar is immediately usable without Google.
7. Bettina may defer iMessage and Google connection until the product has shown
   local value.

### 6.2 Parenting-agreement setup

1. Bettina uploads the signed PDF through resumable, independently hashed
   chunks; there is no whole-document size cap.
2. Eliza verifies every ordered chunk, the complete byte count, and the
   reassembled SHA-256 before accepting the original bytes.
3. Eliza derives the page count from the parser and processes every page.
   Native text is preserved; image-bearing or native-text-empty pages are
   rendered for strict OCR/vision transcription. A verified blank page is
   explicit, and any failed page fails the whole ingestion rather than
   publishing partial content as complete.
4. The PDF becomes an immutable artifact version with complete owner-private
   searchable text and per-page provenance.
5. Eliza extracts proposed obligations with page and source-range citations.
6. Bettina approves, edits, or rejects each proposed obligation.
7. The approved obligation set is pinned to the agent.
8. The original PDF remains available for citation but is not automatically
   injected into every turn.
9. Default access remains owner-only.
10. Bettina may share a specific document or excerpt with the verified
   co-parent guest.

### 6.3 Calendar setup

1. Bettina sees Eliza Calendar as the default calendar of record.
2. She can create, edit, and delete all-day and timed events.
3. She connects `shawgotbags@gmail.com` through Google OAuth for acceptance.
4. She chooses which Eliza calendar is linked to which Google calendar.
5. Initial synchronization produces a preview rather than silently merging.
6. After approval, linked events synchronize in both directions.
7. Conflicting edits are shown for resolution; neither side silently wins.

### 6.4 School-calendar automation

1. Bettina tells Eliza to monitor the Concord school calendar monthly.
2. Eliza creates a visible workflow with typed steps and a monthly trigger.
3. Bettina can inspect every step and click **Run now**.
4. The workflow starts from the stable district page, resolves the current PDF,
   follows approved redirects, and hashes the bytes.
5. The first run extracts relevant district and child-school events.
6. Bettina reviews the complete proposed import.
7. Approved events are written to Eliza Calendar and synchronized to the linked
   Google calendar.
8. The workflow is scheduled monthly.
9. An unchanged hash records a successful no-op.
10. A changed hash triggers parsing and a semantic additions/changes/removals
    diff.
11. Approved revisions update only events managed by this workflow.

### 6.5 Daily iMessage calendar view

1. Bettina asks for today's schedule or receives an approved scheduled summary.
2. Eliza renders a deterministic calendar image appropriate for the verified
   destination.
3. The iMessage contains concise text, the image, and an authenticated link.
4. Lock-screen and link-preview content remain generic.
5. The detailed page requires the intended identity and an unexpired token.

### 6.6 Monthly coordination packet

1. A scheduled job gathers the next month's relevant calendar, school,
   agreement, message, consent, travel, and health-change facts.
2. Every factual statement retains source provenance.
3. Contradictions and missing required facts become explicit questions.
4. Bettina answers or marks questions unresolved.
5. Eliza generates a neutral factual draft as a separate versioned artifact.
6. Bettina sees the recipient, channel, disclosed data classes, citations, and
   exact immutable message.
7. Editing the message creates a new revision and invalidates older approval.
8. Bettina approves delivery through iMessage or another configured channel.
9. Eliza stores the final bytes and provider receipt.

## 7. MVP functional requirements

### 7.1 Authentication and onboarding

- **AUTH-1:** Pairing must succeed from a fresh public browser against the
  deployed single-VPS configuration.
- **AUTH-2:** Pairing errors must distinguish invalid code, expired code,
  disabled pairing, backend not ready, and instance mismatch.
- **AUTH-3:** The product must not require Bettina to infer or edit the correct
  SSH destination.
- **AUTH-4:** Pairing continues to use short-lived, one-time codes and revocable
  machine sessions.
- **AUTH-5:** The owner can view and revoke active sessions.

### 7.2 Agreement knowledge

- **KNOW-1:** Parenting-agreement original bytes must be stored successfully or
  the upload fails; best-effort retention is not sufficient.
- **KNOW-2:** Every artifact version records a binary SHA-256, content SHA-256,
  source actor, upload time, MIME type, and page map.
- **KNOW-3:** Updating an agreement creates a new version rather than replacing
  history.
- **KNOW-4:** Extracted obligations begin in `proposed` state.
- **KNOW-5:** Approved obligations cite the exact artifact version and page or
  geometric range.
- **KNOW-6:** The approved obligation set can be pinned to the agent.
- **KNOW-7:** Pinning the raw agreement is optional and visibly warns about
  broad context activation.
- **KNOW-8:** The owner can export the original, reviewed obligations, hashes,
  pins, grants, and audit history.

### 7.3 Pins and access control

- **ACL-1:** Support explicit pin targets: `agent`, `room`, and `household`.
- **ACL-2:** A room pin activates only when the current canonical room matches.
- **ACL-3:** An agent pin does not grant other people permission.
- **ACL-4:** A specific-person grant requires a verified entity identity.
- **ACL-5:** A grant is read-only and never grants mutation or impersonation.
- **ACL-6:** Co-parent grants are child-, purpose-, and data-class-aware.
- **ACL-7:** Temporary guest grants expire by default.
- **ACL-8:** The co-parent guest remains active until explicit revocation or a
  relationship change, but individual high-sensitivity grants may still expire.
- **ACL-9:** The family UI does not offer internet-public sharing.
- **ACL-10:** Existing `global` scope is labeled “Everyone using this agent,”
  not “Public.”
- **ACL-11:** The permission preview names every recipient and explains what
  each recipient can and cannot do.

### 7.4 Calendar

- **CAL-1:** Eliza Calendar is available and writable without plugins.
- **CAL-2:** The registered Calendar page provides create, edit, and delete
  controls.
- **CAL-3:** Eliza Calendar supports all-day events.
- **CAL-4:** Built-in recurrence is not required for MVP.
- **CAL-5:** Google OAuth can connect a real writable calendar.
- **CAL-6:** Bettina explicitly maps an Eliza calendar to a Google calendar.
- **CAL-7:** Linked event changes synchronize in both directions.
- **CAL-8:** Provider origin, local version, Google event ID, Google `etag`, and
  last synchronized versions are retained.
- **CAL-9:** Synchronization uses stable idempotency keys and incremental Google
  sync tokens.
- **CAL-10:** An expired Google sync token triggers a full reconciliation.
- **CAL-11:** Google push notifications trigger a refetch; notifications are
  never treated as containing the authoritative change.
- **CAL-12:** Conflicting concurrent edits become `conflicted` and require
  resolution.
- **CAL-13:** Unknown provider write outcomes are quarantined rather than
  blindly retried.
- **CAL-14:** Disconnecting Google leaves Eliza events available and clearly
  marks synchronization as paused.

### 7.5 School-calendar workflow

- **SCH-1:** The workflow uses the district landing page as the discovery
  authority.
- **SCH-2:** Network retrieval uses the existing SSRF-guarded fetch boundary,
  HTTPS, redirect caps, byte caps, MIME validation, and PDF signature checks.
- **SCH-3:** The workflow stores the resolved URL, response metadata, PDF bytes,
  and SHA-256.
- **SCH-4:** The current observed baseline PDF hash is
  `840ef8638a7c844627c419eb074aba230b1715f000bc13a91b4905d9aae62a11`.
- **SCH-5:** Matching the last successfully processed hash produces a recorded
  no-op and no calendar writes.
- **SCH-6:** A byte change triggers extraction, but calendar mutations depend on
  semantic diff rather than byte difference alone.
- **SCH-7:** Extraction must account for the untagged two-column PDF layout and
  retain page/geometry provenance.
- **SCH-8:** District-wide dates and the configured child's school/grade dates
  are distinguished.
- **SCH-9:** Ambiguous dates, scope, or conflicting equal-authority revisions
  are quarantined for review.
- **SCH-10:** Every managed event has a stable workflow event key.
- **SCH-11:** A revision can add, update, cancel, or leave an event unchanged.
- **SCH-12:** The workflow never modifies a manually created or unrelated event.
- **SCH-13:** The first import and every changed revision require approval.
- **SCH-14:** Unchanged runs do not require approval.
- **SCH-15:** The workflow exposes Run now, schedule, last run, last changed
  hash, diff, approval, receipts, and failure state.
- **SCH-16:** Default cadence is 9:00 a.m. America/New_York on the first day of
  each month.
- **SCH-17:** Emergency weather closures remain a separate post-MVP source.

### 7.6 Monthly coordination packet

- **PACK-1:** The packet covers one explicit reporting period.
- **PACK-2:** It includes upcoming custody/exchange information present in the
  connected real calendar without requiring built-in custody recurrence.
- **PACK-3:** It includes school closures, early releases, relevant events, and
  provisional last-day implications.
- **PACK-4:** It includes agreement-triggered notices, travel requirements,
  consent requests, material school changes, and material health changes.
- **PACK-5:** It carries unanswered items forward exactly once with their
  original dates.
- **PACK-6:** Expenses are absent from MVP packet logic and UI.
- **PACK-7:** Every factual claim has source provenance.
- **PACK-8:** Missing or contradictory information is displayed separately from
  established facts.
- **PACK-9:** The external draft is versioned independently from the internal
  packet.
- **PACK-10:** Packet assembly may be automatic; external delivery may not.

### 7.7 Neutral factual drafting

- **DRAFT-1:** Preserve dates, times, requests, commitments, urgency, and
  accountability.
- **DRAFT-2:** Remove insults, speculation, diagnoses, motive attribution, and
  unsupported absolute claims.
- **DRAFT-3:** Do not invent empathy, feelings, apologies, or concessions.
- **DRAFT-4:** Do not provide therapeutic or legal conclusions.
- **DRAFT-5:** Show material transformations when wording changes meaning or
  strength.
- **DRAFT-6:** Never state or imply that the draft was delivered before a
  provider receipt exists.

### 7.8 Approvals

- **APPROVAL-1:** Approval policy is based on recipient, household role,
  disclosed data classes, and effect—not connector name.
- **APPROVAL-2:** Co-parent, caregiver, school, and professional sends require
  approval across iMessage, Telegram, Discord, and email.
- **APPROVAL-3:** Calendar additions from a new or changed school revision
  require approval.
- **APPROVAL-4:** Calendar updates and removals require approval.
- **APPROVAL-5:** The review card displays recipient identity, verified handle,
  channel/account, child subjects, exact content, sources, disclosed data
  classes, content hash, and expected effect.
- **APPROVAL-6:** Editing content, recipient, channel, event target, or source
  revision invalidates prior approval.
- **APPROVAL-7:** Duplicate execution is prevented with durable idempotency and
  provider receipts.

### 7.9 iMessage

- **IMSG-1:** Live iMessage acceptance runs through a supported Mac edge.
- **IMSG-2:** The Linux VPS does not pretend to host Messages.app directly.
- **IMSG-3:** The owner can inspect iMessage connector health, permissions, and
  last successful delivery.
- **IMSG-4:** The first calendar presentation is image plus concise text plus an
  authenticated universal link.
- **IMSG-5:** Sensitive images are uploaded directly as transient connector
  bytes or served through a short-lived authenticated endpoint.
- **IMSG-6:** Unredacted family cards must not use the ordinary long-lived
  pre-authenticated `/api/media/<sha256>` route.
- **IMSG-7:** Lock-screen text and link metadata reveal no child name, custody
  status, medical detail, address, or private event title.
- **IMSG-8:** Delivery acceptance includes a real provider receipt and visual
  inspection on the destination device.

### 7.10 Audit, export, revocation, and deletion

- **AUDIT-1:** Audit upload, extraction, review, pin, unpin, grant, revoke,
  source fetch, workflow run, approval, mutation, send, export, and deletion.
- **AUDIT-2:** Audit entries identify exact source and content revisions.
- **AUDIT-3:** Audit language describes system activity, not truth or legal
  sufficiency.
- **AUDIT-4:** Export contains source artifacts, hashes, reviewed obligations,
  packet versions, approvals, calendar receipts, and message receipts.
- **AUDIT-5:** Deletion previews dependent pins, obligations, authority
  baselines, workflows, packets, and calendar events.
- **AUDIT-6:** Revocation removes future access immediately.
- **AUDIT-7:** Purge behavior covers primary storage, derived state, cached
  projections, and eligible backups according to a documented policy.

## 8. Calendar synchronization design

### 8.1 Synchronization model

The MVP implements linked-event synchronization, not indiscriminate copying of
all calendars.

An Eliza event can be linked to one Google event. The link records both sides'
identifiers and versions. Eliza Calendar remains usable while Google is absent
or disconnected.

### 8.2 Event ownership

- Events created in Eliza begin with `calendarOfRecord = eliza`.
- Events imported from Google begin with `calendarOfRecord = google`.
- Linking does not erase origin.
- Either side may subsequently edit a linked event.
- A clean one-sided edit propagates to the other side.
- Concurrent edits produce a conflict.

### 8.3 Required synchronization state

```text
CalendarLink
  id
  agentId
  elizaCalendarId
  googleConnectorAccountId
  googleCalendarId
  status: pending | active | paused | revoked | error
  initialSyncApprovedAt
  createdAt
  updatedAt

CalendarEventLink
  id
  calendarLinkId
  elizaEventId
  googleEventId
  origin: eliza | google
  elizaVersion
  googleEtag
  lastCommonSemanticHash
  lastElizaSemanticHash
  lastGoogleSemanticHash
  state: synced | eliza_dirty | google_dirty | conflicted | delete_pending | error
  lastSyncedAt
  lastError
```

### 8.4 Conflict rules

1. Compute a normalized semantic hash over title, description, location,
   all-day/timed range, timezone, attendees, recurrence, and status.
2. Compare each side to the last common semantic hash.
3. If only one side changed, propagate that side.
4. If both changed to the same semantic state, advance the common version.
5. If both changed differently, create a conflict; do not use last-write-wins.
6. Deletion on one side becomes a reviewed deletion proposal when the other
   side changed since the last common version.
7. Every provider mutation uses an operation ID and expected provider version.

### 8.5 Live Google acceptance

The `shawgotbags@gmail.com` acceptance run must demonstrate:

1. Connect Google through the real OAuth flow.
2. Link a dedicated test Google calendar to Eliza Calendar.
3. Create an Eliza event and observe it in Google.
4. Edit that Google event and observe the edit in Eliza.
5. Edit the Eliza event and observe the edit in Google.
6. Create a Google event and observe it in Eliza.
7. Exercise a concurrent-edit conflict.
8. Delete a managed test event with approval and verify both sides.
9. Disconnect Google and verify Eliza remains usable.
10. Reconnect and reconcile without duplicates.

## 9. School automation architecture

### 9.1 Trusted workflow steps

The visible workflow is backed by typed services. It must not execute arbitrary
model-generated `fetch` or calendar-mutation code.

```text
Monthly trigger / Run now
  -> Discover current calendar resource
  -> Guarded PDF fetch
  -> Immutable artifact + SHA-256
  -> Hash comparison
  -> Layout-aware extraction
  -> Candidate validation and child/school scoping
  -> School-source fact reconciliation
  -> Semantic event diff
  -> Owner approval
  -> Calendar mutation ledger
  -> Eliza Calendar write
  -> Google synchronization
  -> Run receipt and owner notification
```

### 9.2 Source configuration

```text
SchoolCalendarSource
  id
  householdId
  districtName
  landingUrl
  stableResourceUrl
  schoolYear
  timezone
  childEntityIds
  includedScopes
  targetElizaCalendarId
  workflowId
  activeArtifactId
  activeSemanticRevisionId
  lastRunAt
```

### 9.3 Stable event identity

Managed event identity must survive harmless wording and PDF metadata changes.
The key should resemble:

```text
school-calendar:v1:<district>:<school-year>:<scope>:<event-kind>:<start-date>:<end-date>
```

Scope and event-kind normalization are versioned. A normalization-version
change must produce an explicit migration or review, not duplicate events.

### 9.4 Current Concord source

- Discovery page: <https://www.concordps.org/district-resources/school-year-calendars>
- Current PDF: <https://resources.finalsite.net/images/v1767898007/concordpsorg/fngaaxlgullcz1ezh11m/CPSCCRSD2026-2027SchoolCalendar.pdf>
- Approved label on district page: January 7, 2026
- Observed current SHA-256:
  `840ef8638a7c844627c419eb074aba230b1715f000bc13a91b4905d9aae62a11`

## 10. Knowledge and agreement architecture

### 10.1 Immutable artifacts

```text
KnowledgeArtifactVersion
  id
  logicalArtifactId
  priorVersionId
  originalMediaHash
  extractedContentHash
  mimeType
  sourceActorId
  sourceReference
  pageMap
  createdAt
  tombstonedAt
```

### 10.2 Reviewed obligations

```text
AgreementObligation
  id
  artifactVersionId
  obligationType
  partyEntityIds
  childEntityIds
  structuredTerms
  sourcePage
  sourceGeometry
  sourceExcerptHash
  extractorId
  extractorVersion
  state: proposed | approved | rejected | superseded
  reviewedBy
  reviewedAt
```

### 10.3 Pins

```text
KnowledgePin
  id
  artifactVersionId | reviewedCollectionId
  targetKind: agent | room | household
  targetId
  active
  createdBy
  createdAt
  revokedBy
  revokedAt
  reason
```

### 10.4 Guest grants

```text
KnowledgeGrant
  id
  resourceId
  granteeEntityId
  householdId
  childEntityIds
  allowedDataClasses
  purpose
  expiresAt
  state: active | expired | revoked
  createdBy
  createdAt
  revokedAt
```

The permission check determines whether a caller may read. The pin check
determines whether authorized content is active in the current agent context.

## 11. Monthly coordination packet model

```text
CoordinationPacket
  id
  householdId
  reportingStart
  reportingEnd
  sourceCutoffAt
  status: assembling | needs_input | ready | approved | sent | superseded
  sourceRevisionManifest
  scheduleItems
  schoolItems
  agreementNotices
  travelItems
  consentItems
  healthChangeItems
  unansweredItems
  conflicts
  missingInformation
  generatedAt

CoordinationDraft
  id
  packetId
  revision
  recipientEntityId
  connectorKind
  connectorAccountId
  exactText
  disclosedDataClasses
  sourceCitationIds
  semanticHash
  approvalId
  providerReceiptId
```

The packet is an internal decision artifact. The draft is the external
communication artifact. Approving one never implicitly approves the other.

## 12. iMessage delivery architecture

### 12.1 MVP presentation

- Deterministic day image.
- Short generic summary.
- Authenticated universal link to the full day view.
- Optional approve/edit/reject continuation in the Eliza app, not an embedded
  Messages form.

### 12.2 Secure card modes

| Mode | Intended use | Visible content |
| --- | --- | --- |
| Notification-safe | Lock screen and previews | Generic count and time range only |
| Private-DM redacted | Verified owner iMessage | Event times and safe labels; no sensitive details |
| Full authenticated | Eliza app after link authentication | Full authorized calendar detail |

### 12.3 Link requirements

- Short TTL.
- Audience-bound to Bettina's verified identity/session.
- Single-purpose read scope.
- Revocable.
- No PII in URL paths, query parameters, OpenGraph metadata, logs, or referrers.
- `Referrer-Policy: no-referrer`.
- Explicit unavailable/expired state.

## 13. Security and abuse model

### 13.1 Critical threats

| Threat | Required control |
| --- | --- |
| Co-parent requests Bettina's location or full schedule | Child- and purpose-scoped guest capabilities; neutral refusal; safe relay option |
| Forwarded message or PDF instructs the agent to disclose data | Treat all source prose as inert evidence; typed extraction only |
| Wrong recipient or channel | Verified identity and exact immutable approval envelope |
| Draft edited after approval | New content hash and approval invalidation |
| Sensitive image leaks through capability URL | Authenticated expiring endpoint or transient direct upload |
| Google and Eliza overwrite each other | Last-common-version comparison and explicit conflict state |
| Changed PDF appends duplicates | Stable semantic event identity and managed-event diff |
| Removal deletes unrelated event | Workflow ownership check and approved mutation plan |
| Guest relationship changes | Immediate standing and grant invalidation |
| Shared browser or stolen session | Session inventory, revocation, optional local app lock, generic previews |

### 13.2 Data classes

At minimum, approval and access policies distinguish:

- public school-calendar information;
- ordinary child logistics;
- custody schedule;
- location/address;
- school records;
- health and medical information;
- financial information;
- private owner schedule;
- third-party personal information.

## 14. Privacy and compliance boundaries

- MVP is adult-only. Children do not create accounts or supply information
  directly.
- Public school calendars are distinct from school-provided education-record
  PII. Authenticated school integrations require a separate privacy review.
- Google OAuth requests the narrowest scopes capable of the approved sync.
- Massachusetts personal-information safeguards, written security program,
  authentication, access control, vendor management, and incident procedures
  must be assessed before production handling of covered data.
- Retention is owner-controlled within technical and legal constraints.
- Product copy must not promise legal advice, court admissibility, legal hold,
  or evidentiary sufficiency.

Primary references:

- FTC COPPA FAQ: <https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions>
- U.S. Department of Education FERPA guidance: <https://studentprivacy.ed.gov/faq/i-want-use-online-tool-or-application-part-my-course-however-i-am-worried-it-violation-ferpa>
- Massachusetts 201 CMR 17.00: <https://www.mass.gov/regulations/201-CMR-1700-standards-for-the-protection-of-personal-information-of-ma-residents>
- Google Calendar OAuth scopes: <https://developers.google.com/workspace/calendar/api/auth>
- Google incremental synchronization: <https://developers.google.com/workspace/calendar/api/guides/sync>
- Google push notifications: <https://developers.google.com/workspace/calendar/api/guides/push>

## 15. Observability and operational states

Every user-facing workflow must distinguish:

- loading;
- ready;
- no change;
- needs approval;
- needs clarification;
- conflicted;
- temporarily unavailable;
- failed and retryable;
- failed and terminal;
- completed with verified receipt.

Required metrics include:

- pairing success and failure reason;
- connector health and last successful operation;
- workflow run duration and phase;
- source URL and artifact hash changes;
- extracted/accepted/rejected/ambiguous event counts;
- calendar mutation add/update/delete/no-op counts;
- synchronization lag and conflict counts;
- approval latency and invalidation count;
- message accepted/delivered/read/replied state;
- authorization denial and expired-link counts.

Sensitive content, full addresses, medical details, OAuth tokens, pairing codes,
and private card URLs must not be emitted to ordinary logs or trajectories.

## 16. Acceptance and test strategy

### 16.1 Release-gate journey

A fresh Bettina pilot must be able to complete this journey without CLI or
database intervention:

1. Pair and log in from the public URL.
2. Create the private family workspace.
3. Upload a scrubbed parenting agreement.
4. Verify the original hash.
5. Review and activate cited obligations.
6. Pin the reviewed obligations to the agent.
7. Pin selected knowledge to one chat and prove it does not activate elsewhere.
8. Grant the verified co-parent guest one read-only resource and prove another
   identity cannot read it.
9. Create and edit an event in Eliza Calendar without Google.
10. Connect `shawgotbags@gmail.com` and approve initial synchronization.
11. Prove Eliza-to-Google and Google-to-Eliza changes.
12. Create the Concord school workflow from chat.
13. Inspect it and click Run now.
14. Approve the first event import.
15. Run again and observe a verified no-op.
16. Exercise a changed fixture and approve additions/updates/removals.
17. Render and deliver the owner-safe calendar card through real iMessage.
18. Generate the monthly packet.
19. Resolve one missing-information question.
20. Edit and approve a test co-parent draft.
21. Verify the exact delivered bytes and provider receipt.
22. Export the workspace record.
23. Revoke guest access and prove denial.
24. Delete/deactivate a test source with dependency preview.

### 16.2 Required adversarial cases

- Location and schedule privacy probe.
- Child-health canary leakage.
- Wrong-recipient trap.
- Approval-bypass pressure.
- Prompt injection inside a co-parent message.
- Prompt injection inside a school PDF.
- SSRF and malicious redirects.
- Oversized or non-PDF source.
- Same PDF hash replay.
- Metadata-only PDF byte change.
- Corrected date, renamed event, removed event, and ambiguous two-column row.
- Duplicate Run now requests.
- Process restart between approval and mutation.
- Google `410` sync-token expiry.
- Google webhook duplicate and out-of-order delivery.
- Unknown provider acceptance.
- Concurrent Eliza and Google edits.
- Guest grant expiry and relationship revocation.
- Card URL opened by the wrong identity or after expiry.
- Sensitive bytes absent from pre-auth media routes.

### 16.3 Evidence requirements

- Exact current commit and deployed revision.
- Provider-backed scenario trajectories for tone and ambiguity.
- Real Google event readback from `shawgotbags@gmail.com`.
- Real iMessage send and destination-device inspection.
- Backend logs with secrets and private content redacted.
- Frontend console and network logs.
- Database/artifact rows for hashes, links, approvals, and receipts.
- Desktop and mobile screenshots.
- MP4 walkthrough of the complete journey.
- Canonical evidence bundle verification and review.

## 17. Implementation plan

### Phase 0: Stabilize the pilot environment

**Outcome:** The deployed front door and required runtimes are trustworthy.

- Resolve the current pairing failure.
- Complete Bun install/runtime setup and fused-inference readiness separately
  from this product scope.
- Verify exact deployed revision and clean migration behavior.
- Establish Mac iMessage edge connectivity.
- Confirm Google OAuth configuration and test-account access.

**Exit gate:** Fresh-browser pairing, healthy runtime, and connector preflight
pass on the deployment intended for the pilot.

### Phase 1: Family workspace and agreement

- Private family workspace shell.
- Household member and guest management.
- Immutable document versions and guaranteed original retention.
- Agreement extraction, citations, owner review, and activation.
- Pin model and pin UI.
- Verified-person grants, expiry, preview, and revocation.
- Unified audit timeline.

**Exit gate:** The agreement and ACL portion of the release-gate journey passes
with scrubbed fixtures.

### Phase 2: Writable calendar and Google sync

- Mount or adapt the existing rich calendar editor.
- Add built-in all-day support.
- Add calendar-link configuration.
- Implement two-way linked-event synchronization.
- Conflict UI, deletion semantics, disconnect/reconnect reconciliation.
- Live acceptance with `shawgotbags@gmail.com`.

**Exit gate:** Bidirectional create/edit/delete and conflict tests pass without
duplicates or silent overwrite.

### Phase 3: School workflow

- Add typed workflow capability steps.
- Implement guarded Finalsite discovery/fetch/hash.
- Implement layout-aware Concord extraction and evidence geometry.
- Reconcile school-source facts.
- Generate semantic event diff and mutation plan.
- Add approval, run history, Run now, no-op, and failure UX.
- Write to Eliza Calendar and verify Google propagation.

**Exit gate:** First run, unchanged run, corrected PDF, and removal scenarios
pass through the same visible workflow.

### Phase 4: Monthly packet and approvals

- Packet aggregation and source manifest.
- Missing-information and contradiction workflow.
- Neutral factual drafting.
- Complete family review card.
- Approval invalidation and provider receipts.

**Exit gate:** A packet can be assembled, corrected, approved, and delivered as
a test without any unsupported claim of send or legal conclusion.

### Phase 5: iMessage calendar experience

- Deterministic card renderer and redaction modes.
- Authenticated expiring detailed view.
- Mac-edge media/link delivery.
- Connector health and delivery diagnostics.
- Real-device visual and privacy acceptance.

**Exit gate:** The mandatory live iMessage path passes with no sensitive
pre-authenticated media exposure.

### Phase 6: Hardening and pilot launch

- Complete adversarial scenario matrix.
- Provider-backed trajectories.
- App visual audit and iteration.
- Export, deletion, and revocation acceptance.
- Privacy/security review.
- Full evidence bundle and exact-head hosted checks.

## 18. Effort and staffing

Approximate experienced-engineer effort:

| Workstream | Engineer-weeks |
| --- | ---: |
| Pairing and pilot-environment stabilization | 1–2 |
| Family workspace shell | 2–4 |
| Immutable agreement, citations, review | 3–5 |
| Pin and guest-permission model/UI | 3–5 |
| Writable built-in calendar and all-day events | 2–3 |
| True linked Eliza/Google synchronization | 4–8 |
| Trusted workflow capability bridge | 2–4 |
| Concord source fetch, extraction, diff | 4–7 |
| Monthly packet and neutral drafting | 5–8 |
| Unified approval/review experience | 2–4 |
| Secure iMessage card and link | 2–4 |
| Security, scenarios, live E2E, evidence | 3–5 |

Sequential delivery is approximately **24–40 engineer-weeks** because the
confirmed true two-way synchronization and immutable knowledge work are larger
than a presentation-only MVP.

With three coordinated engineers plus part-time product/design and security
support, the realistic critical path is approximately **10–16 calendar weeks**
after the pilot environment is stable. The work should be parallelized across:

1. knowledge/ACL/family workspace;
2. calendar/Google synchronization;
3. school workflow/packet/iMessage integration;
4. centrally owned contracts, approval policy, integration, and evidence.

## 19. Post-MVP roadmap

### Near-term

- Built-in recurring custody schedules.
- Emergency closure and alert sources.
- School newsletters and approved email ingestion.
- Multiple school districts and extraction adapters.
- Parenting-coordinator guest role and bounded exports.
- Rich Telegram and Discord calendar interactions.
- Guest confirmation flows through verified messaging.

### Later

- Shared co-parent views without shared ownership.
- Collaborative schedule proposals and mutual approvals.
- Native iMessage Messages extension.
- Child/teen accounts after dedicated privacy and safety design.
- Multi-household and blended-family permissions.
- Authenticated school portals under separate FERPA/vendor review.
- Caregiver, pet, and elder-care operations.
- Screenshot and Apple Notes ingestion.
- Agreement amendment comparison and dispute workflows.
- Configurable long-term retention and legal-hold support.
- Expenses and reimbursements only as a separately approved product phase.

## 20. Definition of done

MVP is done only when:

- the release-gate journey passes on the exact deployed revision;
- the real Google account proves both synchronization directions;
- the real iMessage path is inspected on the destination device;
- sensitive guest and calendar-card data cannot be accessed outside its
  authorized audience;
- school automation proves first import, unchanged no-op, correction, and
  removal without duplicates;
- external sends and consequential calendar changes are approval-gated across
  all connectors;
- the monthly packet is complete against its source manifest and never
  fabricates legal, factual, or delivery certainty;
- export, revocation, and dependency-aware deletion work from the product UI;
- focused tests, package gates, root verification, hosted checks, app audit,
  provider-backed scenarios, and the reviewed evidence bundle all pass at the
  same commit.

## 21. Existing implementation foundations

The plan should reuse, rather than replace, these existing surfaces:

- Household coordination and child-scoped authority:
  `plugins/plugin-personal-assistant/src/lifeops/household/`
- Family communications and receipt state:
  `plugins/plugin-personal-assistant/src/lifeops/family-communications/`
- School source facts and reconciliation:
  `plugins/plugin-personal-assistant/src/lifeops/school/`
- Approval queue and mutation receipts:
  `plugins/plugin-personal-assistant/src/lifeops/approval-queue*`
- Calendar service, providers, and built-in calendar:
  `plugins/plugin-calendar/src/`
- Scheduling state machine:
  `plugins/plugin-scheduling/src/scheduled-task/`
- Workflow and trigger UI:
  `plugins/plugin-workflow/src/` and
  `packages/ui/src/components/pages/Workflow*.tsx`
- Document storage and ACL enforcement:
  `packages/core/src/features/documents/` and `plugins/plugin-documents/src/`
- iMessage connector:
  `plugins/plugin-imessage/src/`
- Scenario runner and co-parenting catalog:
  `packages/scenario-runner/` and
  `plugins/plugin-personal-assistant/test/scenarios/`

The external `elizaOS/benchmarks` repository should eventually receive a
family-operations quality suite for packet completeness, disclosure precision,
calendar idempotency, neutral-draft faithfulness, and synchronization
correctness. Existing authored scenarios remain necessary but are not deployed
acceptance on their own.
