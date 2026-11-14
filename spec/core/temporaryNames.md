# Atomic publication temporary-name allocation

`utils/atomic-json.ts` owns a process-local `bigint` counter initialized to `0n`. Both synchronous and asynchronous atomic writers call the same `tmpPathFor`, which increments before formatting `target + ".tmp-" + pid + "-" + clock + "-" + counter`. No numeric coercion or wrapping occurs. Mathematical nonnegative integers therefore model the source BigInt exactly for this counter; formatting decimal digits is a pure codec boundary.

## Story: Give concurrent publications distinct temporary paths

### Every allocated name carries a never-repeated process ordinal

The counter is shared across all targets and both writer APIs. PID and wall clock may repeat or move backward without repeating an ordinal. Failed writes consume their ordinal. This is a process-lifetime guarantee; exclusive file creation handles pre-existing names across process restarts.

```quint
type TemporaryName = { target: str, pid: int, clock: int, ordinal: int }
type TemporaryNames = { sequence: int, allocated: List[TemporaryName] }
pure val initial: TemporaryNames = { sequence: 0, allocated: List() }
pure def allocate(s: TemporaryNames, target: str, pid: int, clock: int): TemporaryNames = { sequence: s.sequence + 1, allocated: s.allocated.append({ target: target, pid: pid, clock: clock, ordinal: s.sequence + 1 }) }
pure def alwaysOrdinalUnique(s: TemporaryNames): bool = s.allocated.every(name => name.ordinal > 0 and name.ordinal <= s.sequence and s.allocated.select(other => other.ordinal == name.ordinal).length() == 1)
pure def alwaysEveryAllocationCounted(s: TemporaryNames): bool = s.sequence == s.allocated.length()
pure def stepCounterAdvancesExactlyOnce(before: TemporaryNames, after: TemporaryNames): bool = after.sequence == before.sequence + 1
pure def sometimesRepeatedClockStillUnique(s: TemporaryNames): bool = s.allocated.some(name => s.allocated.some(other => name.target == other.target and name.pid == other.pid and name.clock == other.clock and name.ordinal != other.ordinal))
pure val targetValues = Set("first.json", "second.json")
pure val pidValues = Set(10, 20)
pure val clockValues = Set(0, 100, 50)
```
