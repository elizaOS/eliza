# Advanced memory consolidation and first-run onboarding

## Story: Bound long-term memory growth, keep summaries monotonic, and gate first-run completion

> As the device owner, I want long-term memory storage bounded with monotonic session summary consolidation and first-run onboarding to reach completion only after all required questions are answered or explicitly skipped.

### Memory consolidation and first-run onboarding preserve capacity and completion invariants

Long-term memory keeps `storedCount` within `[0, maxStored]` (`maxStored == 4` in the bounded model) and tracks `consolidatedUpTo <= storedCount` with a non-rewinding `summaryVersion`. First-run onboarding moves from `OnboardingNotStarted` to `OnboardingCollecting`, increments `answeredQuestions` up to `totalQuestions == 3`, and enters `OnboardingCompleted` only when `answeredQuestions == totalQuestions`, or enters `OnboardingSkipped` on explicit skip.

```quint
type FirstRunPhase = OnboardingNotStarted | OnboardingCollecting | OnboardingCompleted | OnboardingSkipped

type MemoryFirstRunState = {
  storedCount: int,
  maxStored: int,
  summaryVersion: int,
  consolidatedUpTo: int,
  firstRunPhase: FirstRunPhase,
  answeredQuestions: int,
  totalQuestions: int
}

pure val initial: MemoryFirstRunState = {
  storedCount: 0,
  maxStored: 4,
  summaryVersion: 0,
  consolidatedUpTo: 0,
  firstRunPhase: OnboardingNotStarted,
  answeredQuestions: 0,
  totalQuestions: 3
}

pure def canRecordMemoryItem(s: MemoryFirstRunState): bool =
  s.storedCount < s.maxStored

pure def recordMemoryItem(s: MemoryFirstRunState): MemoryFirstRunState =
  { ...s, storedCount: s.storedCount + 1 }

pure def canConsolidateSummary(s: MemoryFirstRunState): bool =
  s.storedCount > s.consolidatedUpTo

pure def consolidateSummary(s: MemoryFirstRunState): MemoryFirstRunState =
  { ...s, consolidatedUpTo: s.storedCount, summaryVersion: s.summaryVersion + 1 }

pure def canEvictOldestMemory(s: MemoryFirstRunState): bool =
  s.storedCount > 0

pure def evictOldestMemory(s: MemoryFirstRunState): MemoryFirstRunState =
  val nextStored = s.storedCount - 1
  val nextConsolidated = if (s.consolidatedUpTo > nextStored) nextStored else s.consolidatedUpTo
  { ...s, storedCount: nextStored, consolidatedUpTo: nextConsolidated }

pure def canStartFirstRun(s: MemoryFirstRunState): bool =
  s.firstRunPhase == OnboardingNotStarted

pure def startFirstRun(s: MemoryFirstRunState): MemoryFirstRunState =
  { ...s, firstRunPhase: OnboardingCollecting, answeredQuestions: 0 }

pure def canAnswerFirstRunQuestion(s: MemoryFirstRunState): bool =
  s.firstRunPhase == OnboardingCollecting and s.answeredQuestions < s.totalQuestions

pure def answerFirstRunQuestion(s: MemoryFirstRunState): MemoryFirstRunState =
  { ...s, answeredQuestions: s.answeredQuestions + 1 }

pure def canCompleteFirstRun(s: MemoryFirstRunState): bool =
  s.firstRunPhase == OnboardingCollecting and s.answeredQuestions == s.totalQuestions

pure def completeFirstRun(s: MemoryFirstRunState): MemoryFirstRunState =
  { ...s, firstRunPhase: OnboardingCompleted }

pure def canSkipFirstRun(s: MemoryFirstRunState): bool =
  s.firstRunPhase == OnboardingNotStarted or s.firstRunPhase == OnboardingCollecting

pure def skipFirstRun(s: MemoryFirstRunState): MemoryFirstRunState =
  { ...s, firstRunPhase: OnboardingSkipped }

pure def alwaysMemoryAndFirstRunSafety(s: MemoryFirstRunState): bool =
  s.maxStored == 4 and
  s.totalQuestions == 3 and
  s.storedCount >= 0 and s.storedCount <= s.maxStored and
  s.consolidatedUpTo >= 0 and s.consolidatedUpTo <= s.storedCount and
  s.summaryVersion >= 0 and
  s.answeredQuestions >= 0 and s.answeredQuestions <= s.totalQuestions and
  (s.firstRunPhase == OnboardingCompleted implies s.answeredQuestions == s.totalQuestions)

pure def stepSummaryVersionNeverRewinds(before: MemoryFirstRunState, via: str, after: MemoryFirstRunState): bool =
  after.summaryVersion >= before.summaryVersion

pure def sometimesConsolidatedSummary(s: MemoryFirstRunState): bool =
  s.summaryVersion >= 1 and s.consolidatedUpTo >= 1

pure def sometimesFirstRunCompleted(s: MemoryFirstRunState): bool =
  s.firstRunPhase == OnboardingCompleted

pure val eval_witness_sometimesFirstRunCompleted = (
  ("startFirstRun"),
  ("answerFirstRunQuestion"),
  ("answerFirstRunQuestion"),
  ("answerFirstRunQuestion"),
  ("completeFirstRun")
)
```
