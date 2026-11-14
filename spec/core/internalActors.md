# Runtime-managed internal actor references

The source is `packages/core/src/security/trusted-delivery-audience.ts` at the pinned baseline. Each runtime/actor registration returns an idempotent disposer. Overlapping trigger deliveries retain independent ownership, and another runtime cannot borrow their trust.

## Story: Keep an internal actor registered while any owner still uses it

### Each disposer removes only its own registration

```quint
type InternalCaller = ManagedRuntime | ExternalCaller
pure val byValues = Set(ManagedRuntime, ExternalCaller)
type InternalRegistration = { token: int, runtime: str, actor: str }
type InternalActors = { nextToken: int, registrations: List[InternalRegistration] }
pure val initial: InternalActors = { nextToken: 1, registrations: List() }
pure val runtimeValues = Set("runtime1", "runtime2")
pure val actorValues = Set("actor1", "actor2")
pure val tokenValues = Set(1, 2, 3)
pure def canRegister(s: InternalActors, by: InternalCaller, runtime: str, actor: str): bool = by == ManagedRuntime and runtime != "" and actor != ""
pure def register(s: InternalActors, by: InternalCaller, runtime: str, actor: str): InternalActors = { ...s, registrations: s.registrations.append({ token: s.nextToken, runtime: runtime, actor: actor }), nextToken: s.nextToken + 1 }
pure def canDispose(s: InternalActors, by: InternalCaller): bool = by == ManagedRuntime
pure def dispose(s: InternalActors, by: InternalCaller, token: int): InternalActors = { ...s, registrations: s.registrations.select(entry => entry.token != token) }
pure def internalActorTrusted(s: InternalActors, runtime: str, actor: str): bool = s.registrations.some(entry => entry.runtime == runtime and entry.actor == actor)
pure def alwaysRegistrationTokensAreUnique(s: InternalActors): bool = s.nextToken > 0 and s.registrations.every(entry => entry.token > 0 and entry.token < s.nextToken and s.registrations.select(other => other.token == entry.token).length() == 1)
pure def sometimesOverlappingOwners(s: InternalActors): bool = s.registrations.select(entry => entry.runtime == "runtime1" and entry.actor == "actor1").length() > 1
```
