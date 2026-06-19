---
name: unit-commitment-operating-rules
description: Use for day-ahead or multi-period unit commitment problems, including thermal on/off schedules, dispatch, startup/shutdown logic, minimum up/down time, ramping, spinning reserve deliverability, renewable curtailment, operating-cost accounting, and independent feasibility checks for power-system operations schedules.
---

# Unit Commitment Operating Rules

Use this skill when a task asks for a day-ahead or multi-period unit commitment schedule with generators, load, reserves, operating constraints, and cost tradeoffs.

This is a reusable UC operating guide. It gives formulation and validation patterns, not a complete task-specific mathematical model.

## UC In One Paragraph

Unit commitment decides which generators are online over time, when they start or stop, how much they produce, and how much reserve they can physically provide. It is harder than hourly economic dispatch because startup/shutdown decisions, ramping, minimum up/down time, reserve deliverability, initial conditions, and cost curves couple one period to the next.

## Keep These Concepts Separate

For each thermal unit `g` and period `t`:

```python
u[g, t]      # commitment/on status, binary
start[g, t]  # startup transition, binary
stop[g, t]   # shutdown transition, binary
p[g, t]      # production variable: know whether actual MW or above-minimum MW
r[g, t]      # scheduled reserve
```

Reports often require actual MW output. Many UC models internally use output above minimum:

```python
actual_output = pmin[g] * u[g, t] + p_above_min[g, t]
p_above_min = actual_output - pmin[g] * u[g, t]
```

Do not mix these conventions in ramping, reserve, cost, or reporting.

## Core Feasibility Checks

Before reporting a schedule, independently verify:

- every resource appears exactly once and all time-series have length `T`;
- commitment, startup, and shutdown are binary;
- offline thermal units have zero production and zero reserve;
- online thermal units respect min/max output;
- must-run units are online when required;
- startup/shutdown indicators match commitment transitions;
- demand balance holds in every period;
- renewable output stays within period-specific bounds;
- scheduled reserve meets the system requirement;
- reserve is deliverable under headroom, startup/shutdown capability, and ramp limits;
- minimum up/down time and initial conditions are respected;
- cost and summary fields are recomputed from arrays.

## Transition Logic

Link startup/shutdown to commitment and the initial state:

```python
prev_u = initial_on[g] if t == 0 else u[g, t - 1]
u[g, t] - prev_u == start[g, t] - stop[g, t]
start[g, t] + stop[g, t] <= 1
```

Equivalent validation pattern:

```python
prev_on = initial_on[g]
for t in range(T):
    assert start[g, t] == int(u[g, t] == 1 and prev_on == 0)
    assert stop[g, t] == int(u[g, t] == 0 and prev_on == 1)
    prev_on = u[g, t]
```

## Capacity And Offline Zeroes

For actual-MW production:

```python
pmin[g] * u[g, t] <= production[g, t] <= pmax[g] * u[g, t]
0 <= reserve[g, t]
```

For above-minimum production:

```python
cap = pmax[g] - pmin[g]
0 <= p_above_min[g, t] <= cap * u[g, t]
0 <= reserve[g, t]
```

If `u[g, t] == 0`, both production and reserve must be zero.

## Demand, Renewables, And System Reserve

Use the task's system/zone/network convention. For a single-zone system:

```python
thermal_gen = sum(actual_thermal[g, t] for g in thermal_units)
renew_gen = sum(renewable_output[r, t] for r in renewable_units)
assert abs(thermal_gen + renew_gen - demand[t]) <= tol
assert sum(reserve[g, t] for g in thermal_units) >= reserve_requirement[t] - tol
```

Renewables:

```python
renewable_min[r, t] <= renewable_output[r, t] <= renewable_max[r, t]
```

If min equals max, output is fixed. If curtailment is allowed, output may be below max. Do not count renewable headroom as spinning reserve unless the prompt explicitly allows it.

## Reserve Deliverability

Reserve is not just unused nameplate capacity. Production and reserve compete for the same physical capability, and reserve must be deployable.

Headroom-only checks are too weak:

```python
# Not enough by itself:
reserve[g, t] <= pmax[g] - production[g, t]
reserve[g, t] <= ramp_up[g]
```

Use joint production-plus-reserve checks. With actual-MW production:

```python
production[g, t] + reserve[g, t] <= pmax[g] * u[g, t]
```

With above-minimum production:

```python
p_above_min[g, t] + reserve[g, t] <= (pmax[g] - pmin[g]) * u[g, t]
```

Startup capability can tighten the startup period. If `startup_limit` is maximum total output during startup:

```python
if start[g, t] == 1:
    production[g, t] + reserve[g, t] <= startup_limit[g]
```

A linear above-minimum pattern is:

```python
startup_reduction = max(pmax[g] - startup_limit[g], 0.0)
p_above_min[g, t] + reserve[g, t] <= (
    (pmax[g] - pmin[g]) * u[g, t]
    - startup_reduction * start[g, t]
)
```

Apply analogous shutdown-period or pre-shutdown capability rules when the data and prompt require them.

## Ramping

Use initial output/status for the first period. When reserve must be deliverable, ramp-up usually applies to production plus reserve:

```python
previous = initial_above_min[g] if t == 0 else p_above_min[g, t - 1]
p_above_min[g, t] + reserve[g, t] - previous <= ramp_up[g]
previous - p_above_min[g, t] <= ramp_down[g]
```

If your model uses actual production, convert consistently before applying above-minimum ramp checks. Recheck ramping after any dispatch or repair step.

## Minimum Up/Down Time

Minimum up/down constraints are time-window constraints triggered by starts/stops. Validation pattern:

```python
if start[g, t] == 1:
    for tau in range(t, min(T, t + min_up[g])):
        assert u[g, tau] == 1

if stop[g, t] == 1:
    for tau in range(t, min(T, t + min_down[g])):
        assert u[g, tau] == 0
```

Account for pre-horizon time already on/off. Follow the prompt on whether post-horizon obligations are enforced.

## Startup Costs

Startup cost may depend on prior offline duration. A common tier rule is largest lag not exceeding prior offline duration:

```python
def choose_startup_cost(tiers, offline_duration):
    tiers = sorted(tiers, key=lambda z: z["lag"])
    chosen = tiers[0]
    for tier in tiers:
        if tier["lag"] <= offline_duration:
            chosen = tier
        else:
            break
    return chosen["cost"]
```

Update offline duration from initial status and the commitment trajectory. Be careful: duration should describe time offline before the startup period.

## Production Costs

Use only cost components present in the data or required by the prompt. Do not invent no-load, reserve, curtailment, shutdown, or ramping costs.

For total-cost breakpoints:

```python
def total_cost_from_curve(points, output_mw):
    pts = sorted((p["mw"], p["cost"]) for p in points)
    if output_mw <= pts[0][0]:
        return pts[0][1]
    if output_mw >= pts[-1][0]:
        return pts[-1][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= output_mw <= x1:
            return y0 + (output_mw - x0) * (y1 - y0) / (x1 - x0)
    raise ValueError("output outside curve")
```

If the first point is at minimum output, its cost may represent online minimum-output cost. Do not add another fixed online cost unless the data says so.

## Implementation Workflow

1. Parse and normalize resource/time arrays.
2. Choose actual-output or above-minimum internal variables and stick to it.
3. Include hard feasibility constraints before optimizing cost.
4. Extract the solution into the report convention.
5. Run independent validation on extracted arrays.
6. Recompute costs and summaries from arrays.
7. Write `"pass"` checks only after validation passes.

## Common Pitfalls

- Treating UC as independent hourly dispatch.
- Counting reserve from offline units or renewable headroom.
- Checking reserve headroom but forgetting startup or ramp deliverability.
- Ignoring initial output in first-period ramping.
- Ignoring initial on/off duration in minimum up/down constraints.
- Trusting a repair LP that omits a constraint family.
- Hard-coding `"pass"` fields before validation.
