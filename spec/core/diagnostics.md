# Structured diagnostics

The baseline is `runtime.ts` methods `reportError` and
`getRecentReportedErrors`, `errors.ts`, `security/redact.ts` and
`security/log-redaction.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`.

## Story: Observe a failure without failing the reporting path

As an operator, I receive the original failure code, severity, scope,
context and cause. Diagnostic subscriber failures remain observable and
cannot cause recursive event emission. The recent-error ring retains the
newest 200 entries in order, as in the current runtime.

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

## Story: Redact untrusted diagnostic fields at the sink

As an operator, I can inspect diagnostic structure while credentials and
unreadable properties are replaced before transport. Concrete pattern
matching retains the existing credential pattern corpus, exact literal
replacement, longest-secret-first ordering, Unicode boundaries and
hostile-getter handling. Those parser details require adapter tests.

### A credential field emits only a replacement marker

This field model is the sink contract after key and pattern classification.
Classification remains a separately tested boundary and cannot be supplied
by a diagnostic caller as authority to bypass masking.

```quint
type SecretText = str
type LogField = PublicField({ name: str, text: str }) | CredentialField({ name: str, credential: SecretText }) | UnreadableField({ name: str })
type SafeField = { name: str, text: str }
pure def redactField(logValue: LogField): SafeField = match logValue {
  | PublicField(v) => { name: v.name, text: v.text }
  | CredentialField(v) => { name: v.name, text: "[REDACTED]" }
  | UnreadableField(v) => { name: v.name, text: "[REDACTION_FAILED]" }
}
pure val logValueValues = Set(PublicField({ name: "scope", text: "storage" }), CredentialField({ name: "token", credential: "secret-material" }), UnreadableField({ name: "hostile" }))
pure def lawCredentialIsMasked(name: str, credential: SecretText): bool = redactField(CredentialField({ name: name, credential: credential })).text == "[REDACTED]"
pure def lawUnreadableFieldIsMasked(name: str): bool = redactField(UnreadableField({ name: name })).text == "[REDACTION_FAILED]"
```
