# Outbound envelope rejection

The source is `packages/core/src/security/outbound-envelope-guard.ts` at the pinned baseline. A per-stream latch accumulates a rejection when the complete output so far contains external envelope material. Detection is the shared pure content policy. This state owns reporting and forwarding after that policy's decision.

## Story: Stop forwarding after external envelope material is detected

### The first positive detection trips the stream and reports once

```quint
type Envelope = { tripped: bool, reports: int, forwarded: int }
pure val initial: Envelope = { tripped: false, reports: 0, forwarded: 0 }
pure def observe(s: Envelope, accumulatedContainsEnvelope: bool): Envelope =
  if (s.tripped) s
  else if (accumulatedContainsEnvelope) { ...s, tripped: true, reports: s.reports + 1 }
  else { ...s, forwarded: s.forwarded + 1 }
pure def alwaysEnvelopeReportsOnce(s: Envelope): bool = s.reports == (if (s.tripped) 1 else 0)
pure def stepTripIsPermanent(before: Envelope, after: Envelope): bool = before.tripped implies (after.tripped and after.forwarded == before.forwarded)
pure def sometimesEnvelopeBlocked(s: Envelope): bool = s.tripped and s.reports == 1
```
