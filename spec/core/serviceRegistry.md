# Service registry observations

The authoritative service state is [service instances and generations](./serviceInstances.md), composed with epoch ownership in [plugin services](./pluginServices.md). These pure views replace the earlier separately stored class-lifecycle projection. Sources are `packages/core/src/runtime/service-lifecycle.ts` and `plugin-lifecycle.ts` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`.

## Story: Observe one shared class and instance registry

As a caller I observe published instances, captured acquisition results and stopped status from the same state that owns start and stop promises. Publication follows declaration order and preserves repeated entries without creating separate start operations. Teardown filters published arrays by object identity while retaining a surviving class's own instance reference.

### Registry observations are pure projections of detailed instance state

```quint
import serviceInstances as I from "./serviceInstances"
pure def registeredTypeStatus(s: I::ServiceInstances, serviceType: str): I::TypeStatus = I::serviceTypeEntry(s, serviceType).status
pure def retainedLoadPromise(s: I::ServiceInstances, serviceType: str): int = I::serviceTypeEntry(s, serviceType).promiseId
pure def pendingTypeAggregate(s: I::ServiceInstances, serviceType: str): int = I::serviceTypeEntry(s, serviceType).latestAggregate
pure def serviceEntry(s: I::ServiceInstances, classId: int): I::ServiceClassEntry = I::serviceClass(s, classId)
pure def serviceClass(s: I::ServiceInstances, serviceType: str): int = I::firstLive(s, serviceType)
pure def declaredInstances(s: I::ServiceInstances, serviceType: str): List[int] = I::publishedInstances(s, serviceType)
pure def ensureCall(s: I::ServiceInstances, callId: int): I::Acquire = I::acquireCall(s, callId)
pure def validClassIdentityUnique(s: I::ServiceInstances): bool = s.classes.every(c => s.classes.select(other => other.id == c.id).length() == 1)
pure def validClassLifecycle(s: I::ServiceInstances): bool = I::alwaysDeclarationsMatch(s) and I::alwaysObjectStopOnce(s) and I::alwaysAttemptGeneration(s)
pure def validEnsureSuccessHasIdentity(s: I::ServiceInstances): bool = s.calls.every(c => c.status == I::AcquireSucceeded implies c.result > 0)
pure def validStoppedRegistryHasNoPublishedService(s: I::ServiceInstances): bool = I::alwaysStoppedHasNoPublication(s)
pure def observedConcurrentEnsuresJoin(s: I::ServiceInstances): bool = s.calls.some(a => s.calls.some(b => a.id != b.id and a.attempts == b.attempts and a.attempts.length() > 0))
pure def observedSiblingStartFailureSurvives(s: I::ServiceInstances): bool = s.classes.some(a => s.classes.some(b => a.id != b.id and a.serviceType == b.serviceType and a.failed and b.live != 0))
pure def observedUnloadRetainsSibling(s: I::ServiceInstances): bool = s.classes.some(a => s.classes.some(b => a.id != b.id and not(a.registered) and a.serviceType == b.serviceType and b.live != 0))
pure def observedLateStartRetired(s: I::ServiceInstances): bool = s.attempts.some(a => a.phase == I::StartFailed and a.instance != 0 and I::serviceObject(s, a.instance).stopCalls == 1)
```
