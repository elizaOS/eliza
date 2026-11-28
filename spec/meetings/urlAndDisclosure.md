# Meeting join URL validation, viewer disclosure, and segment admission

Deterministic safety rules ensuring join requests only admit valid HTTPS links
matching the requested provider, viewer-scoped session reads fail closed when a
transcript row is missing or ungranted, and hallucinated or malformed ASR
segments are never appended to a meeting transcript.

## Story: Enforce HTTPS provider matching, fail-closed transcript disclosure, and clean segment admission

> As an owner, I want meeting joins to reject non-HTTPS or mismatched provider
> links, session reads to withhold transcript references unless the viewer is
> authorized, and ASR hallucination or ordering bugs to be filtered before
> entering the transcript.

### Join requests require HTTPS and matching provider identity

A join request is authorized only when the URL uses HTTPS, the parsed host
belongs to a supported meeting provider, the requested provider (when explicit)
matches the parsed URL provider, and no active session already exists for that
same native meeting identifier.

```quint
type JoinCheck =
  | JoinAdmitted
  | JoinInvalidUrl
  | JoinPlatformMismatch
  | JoinAlreadyActive

pure def checkMeetingJoin(
  httpsUrl: bool,
  hostRecognized: bool,
  providerMatches: bool,
  alreadyActive: bool
): JoinCheck =
  if (not(httpsUrl) or not(hostRecognized)) JoinInvalidUrl
  else if (not(providerMatches)) JoinPlatformMismatch
  else if (alreadyActive) JoinAlreadyActive
  else JoinAdmitted

pure def lawNonHttpsNeverAdmitted(hostRecognized: bool, providerMatches: bool, alreadyActive: bool): bool =
  checkMeetingJoin(false, hostRecognized, providerMatches, alreadyActive) == JoinInvalidUrl

pure def lawDuplicateActiveJoinRefused(httpsUrl: bool, hostRecognized: bool, providerMatches: bool): bool =
  (httpsUrl and hostRecognized and providerMatches) implies checkMeetingJoin(httpsUrl, hostRecognized, providerMatches, true) == JoinAlreadyActive
```

### Transcript disclosure fails closed when a row is missing or ungranted and filters unusable segments

When projecting a meeting session for a viewer, a missing or unparseable
transcript row always yields `DisclosureWithheld`. The owner receives
`DisclosureFull`; non-owners receive `DisclosureFull` only with a full grant,
`DisclosureRedacted` only with a redacted grant, and `DisclosureWithheld`
otherwise. An ASR segment is admitted only when it is not flagged as a
hallucination, carries non-empty speaker and text, has non-negative monotonic
bounds, and matches the expected sequence number.

```quint
type ViewerDisclosure = DisclosureFull | DisclosureRedacted | DisclosureWithheld

pure def resolveMeetingDisclosure(
  rowPresent: bool,
  rowParseable: bool,
  viewerIsOwner: bool,
  hasFullGrant: bool,
  hasRedactedGrant: bool
): ViewerDisclosure =
  if (not(rowPresent) or not(rowParseable)) DisclosureWithheld
  else if (viewerIsOwner or hasFullGrant) DisclosureFull
  else if (hasRedactedGrant) DisclosureRedacted
  else DisclosureWithheld

pure def segmentAdmitted(
  isHallucination: bool,
  hasSpeaker: bool,
  hasWords: bool,
  validBounds: bool,
  seqMatches: bool
): bool =
  not(isHallucination) and hasSpeaker and hasWords and validBounds and seqMatches

pure def lawMissingRowAlwaysWithheld(rowParseable: bool, viewerIsOwner: bool, hasFullGrant: bool, hasRedactedGrant: bool): bool =
  resolveMeetingDisclosure(false, rowParseable, viewerIsOwner, hasFullGrant, hasRedactedGrant) == DisclosureWithheld

pure def lawCorruptRowAlwaysWithheld(rowPresent: bool, viewerIsOwner: bool, hasFullGrant: bool, hasRedactedGrant: bool): bool =
  resolveMeetingDisclosure(rowPresent, false, viewerIsOwner, hasFullGrant, hasRedactedGrant) == DisclosureWithheld

pure def lawHallucinationNeverAdmitted(hasSpeaker: bool, hasWords: bool, validBounds: bool, seqMatches: bool): bool =
  not(segmentAdmitted(true, hasSpeaker, hasWords, validBounds, seqMatches))
```
