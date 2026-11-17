# Structured diagnostics

Runtime error reporting keeps a bounded ring of recent reports and emits an
error event for each report not raised by a subscriber. The logging sink
redacts fields as [content and outbound security](./security.md) says, and
the browser-safe logging leaf gives a renderer's own sink the same logger
contract and the same redaction.
[Integration telemetry](./integrationTelemetry.md) keeps its own once-only
latch.

## Story: Observe a failure without failing the reporting path

> As an operator, I want every runtime failure reported with its original
> identity, so a failing diagnostic subscriber never hides it or loops.

As an operator, I receive the original failure code, severity, scope,
context and cause. Diagnostic subscriber failures remain observable and
cannot cause recursive event emission. The recent-error ring retains the
newest 200 entries in order.

### A structured failure retains its identity and an unclassified one gets a code

The cause identifier represents the original thrown object. The
implementation preserves object identity and the native cause chain.

```quint
type Severity = Unspecified | Ephemeral | Fatal
type Report = { scope: str, code: str, message: str, causeId: str, severity: Severity }
pure def normalized(error: Report, structured: bool, fallback: str): Report = if (structured) error else { ...error, code: fallback }
pure def lawStructuredErrorRetainsIdentity(error: Report, fallback: str): bool = normalized(error, true, fallback) == error
pure def lawUnknownErrorPreservesCause(error: Report, fallback: str): bool = normalized(error, false, fallback).causeId == error.causeId
pure val errorValues = Set({ scope: "provider", code: "PROVIDER_FAILED", message: "failed", causeId: "original", severity: Ephemeral }, { scope: "storage", code: "SETTING_DECRYPTION_FAILED", message: "failed", causeId: "cipher", severity: Fatal })
pure val entryValues = errorValues
```

### Reporting records one entry and an asynchronous subscriber cannot reemit

Synchronous reentry is warn-only. A later error from an asynchronous
subscriber records an entry while suppressing another error event.
An event-delivery failure releases that pending event and records a warning.
The logging sink is itself a total best-effort boundary.

```quint
type Diagnostics = { entries: List[Report], inProgress: bool, pendingEvents: int, emittedEvents: int, completedEvents: int, warnings: int }
pure val initial: Diagnostics = { entries: List(), inProgress: false, pendingEvents: 0, emittedEvents: 0, completedEvents: 0, warnings: 0 }
pure def boundedAppend(entries: List[Report], entry: Report): List[Report] = if (entries.length() >= 200) entries.tail().append(entry) else entries.append(entry)
pure def canReportFailure(d: Diagnostics, entry: Report, subscriber: bool): bool = not(d.inProgress)
pure def reportFailure(d: Diagnostics, entry: Report, subscriber: bool): Diagnostics = { ...d, entries: boundedAppend(d.entries, entry), inProgress: true, pendingEvents: d.pendingEvents + (if (subscriber) 0 else 1), emittedEvents: d.emittedEvents + (if (subscriber) 0 else 1) }
pure def canFinishReporting(d: Diagnostics): bool = d.inProgress
pure def finishReporting(d: Diagnostics): Diagnostics = { ...d, inProgress: false }
pure def canReenterReporting(d: Diagnostics): bool = d.inProgress
pure def reenterReporting(d: Diagnostics): Diagnostics = { ...d, warnings: d.warnings + 1 }
pure def canCompleteDelivery(d: Diagnostics, ok: bool): bool = d.pendingEvents > 0
pure def completeDelivery(d: Diagnostics, ok: bool): Diagnostics = { ...d, pendingEvents: d.pendingEvents - 1, completedEvents: d.completedEvents + 1, warnings: d.warnings + (if (ok) 0 else 1) }
pure def alwaysRingIsBounded(d: Diagnostics): bool = d.entries.length() <= 200
pure def alwaysDeliveryAccounted(d: Diagnostics): bool = d.pendingEvents >= 0 and d.completedEvents >= 0 and d.emittedEvents == d.pendingEvents + d.completedEvents and d.warnings >= 0
pure def stepReentryKeepsOriginalRecord(before: Diagnostics, via: str, after: Diagnostics): bool = via == "reenterReporting" implies after.entries == before.entries and after.emittedEvents == before.emittedEvents
pure def sometimesSubscriberFailureRecorded(d: Diagnostics): bool = d.entries.length() > d.emittedEvents
pure def sometimesDeliveryFailureWarned(d: Diagnostics): bool = d.completedEvents > 0 and d.warnings > 0
```

## Story: Log from a renderer with the core logger contract

> As the maker of a client that runs in a browser or a device web view, I log
> through the same logger contract as the host and never write a secret the
> host's own sink would have hidden.

### A renderer's log line redacts its trailing arguments as the host sink does

The logging leaf exports the logger contract and the redaction of trailing
arguments, and nothing that starts the host's logger. A renderer sink built
on it writes each field of a line exactly as the host sink writes it: a
secret field is masked, an unreadable one gets the failure marker, and an
ordinary one is written unchanged.

```quint
import security as Sec from "./security"
pure def rendererLine(logFields: List[Sec::LogField]): List[Sec::LogField] = Sec::redactLine(logFields)
pure def lawRendererLineHidesWhatTheHostHides(logFields: List[Sec::LogField]): bool =
  rendererLine(logFields).every(f => not(Sec::mustRedact(f)) or f.value == Sec::redactionMarker or f.value == Sec::unreadableMarker) and
    rendererLine(logFields).length() == logFields.length()
```
