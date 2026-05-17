---
name: ordered-window-sequencing-mip
description: "Permutation and sequencing integer-programming formulations with ordered local-window variables, prefix/suffix continuity, and overlap penalties. Use when assigning exams, jobs, tasks, visits, blocks, or resources to ordered positions and costs depend on adjacent pairs, sliding triples, n-grams, short-horizon pressure, or overlapping local patterns."
---

# Ordered-Window Sequencing MIPs

## Core idea

When a sequencing objective depends on neighboring ordered patterns, a plain
item-position assignment model may be too weak or too easy to linearize
incorrectly. Model the local ordered patterns that the objective scores, then
link those patterns so they form one consistent sequence.

Use this pattern for schedules, routes, job orders, block sequences, timetables,
shift plans, and other ordered assignments where costs depend on adjacent pairs,
sliding windows, or overlapping local events.

## Modeling workflow

1. Identify the ordered positions: periods, route stops, sequence indices, slots,
   machine positions, or service windows.
2. Identify the items to place: jobs, exams, blocks, visits, tasks, resources, or
   customer groups.
3. Decide which binary variables match the objective structure:
   - assignment variables for item-position placement;
   - arc variables for predecessor-successor relationships;
   - ordered-window variables for local patterns of length two or more.
4. Add hard feasibility constraints before optimizing: each item appears exactly
   as required, each required position is filled, invalid placements are blocked,
   and local windows cannot contain repeated items unless repeats are allowed.
5. Add auxiliary variables for adjacent pairs, sliding triples, longer windows,
   or overlapping local patterns.
6. Link auxiliary variables tightly to the primary sequence representation.
7. Build named objective components and minimize the weighted sum defined by the
   instance.
8. Extract the final sequence and audit the objective independently.

## Preserve ordered tuple data

Treat tuple-indexed costs or counts as ordered unless the task explicitly says
they are unordered. A schedule induces direction through the order of positions.

For a window beginning at position `t`, use the tuple in sequence order:

```python
pair_key = (item_at[t], item_at[next_t])
triple_key = (item_at[t], item_at[next_t], item_at[next_next_t])
```

Do not sort, canonicalize, symmetrize, or aggregate tuple keys unless the task
says the data are unordered:

```python
# Wrong for directed or ordered sequence costs unless explicitly allowed.
key = tuple(sorted((a, b, c)))
```

Sorting tuple keys can turn a directed sequence objective into a different
unordered objective.

Before coding the objective, inspect the data schema and write down the tuple
semantics you will use:

- If rows are keyed as `(i, j)` or `(i, j, k)`, the safe default is ordered.
- Do not add reverse pairs, sorted triples, or all permutations unless the
  source explicitly says the table is symmetric or unordered.
- If the table contains both `(i, j)` and `(j, i)`, that does not by itself mean
  both should be summed for one ordered window. It may simply be a complete
  ordered table.
- If tuple rows are missing, decide from the task/data whether missing means
  zero, invalid, or impossible before optimizing.

For each objective component, implement one small evaluator expression that
matches the component definition exactly:

```python
component = 0
for start in eligible_starts:
    key = tuple(item_at_position(start, offset) for offset in offsets)
    component += weight_table.get(key, 0)
```

Use this evaluator as the reference for both optimization checks and final
metrics.

## Assignment-linked local windows

If using assignment variables,

```text
assign[i, t] = 1 if item i is assigned to ordered position t
```

then create a local-window indicator for each ordered tuple and eligible start
position. For a length-3 window:

```text
window[i, j, k, t] = 1 if i, j, k occupy positions t, next(t), next(next(t))
```

A standard linearization is:

```python
window[i, j, k, t] <= assign[i, t]
window[i, j, k, t] <= assign[j, next_t]
window[i, j, k, t] <= assign[k, next_next_t]
window[i, j, k, t] >= assign[i, t] + assign[j, next_t] + assign[k, next_next_t] - 2
```

Use the same pattern for adjacent pairs or longer local windows. Create only
eligible starts when the task defines a start-position mask.

## Direct ordered-window model

Some sequencing problems are cleaner with ordered-window variables as the main
sequence representation:

```text
W[t, a1, a2, ..., ar] = 1
```

meaning that the ordered tuple `(a1, a2, ..., ar)` starts at position `t`.
This is useful when the objective primarily scores sliding windows and their
overlaps.

Typical constraint families are:

- exactly one selected window at each eligible start;
- each item appears the required number of times in each position role;
- local windows with repeated items are prohibited when the sequence is a
  permutation;
- neighboring windows agree on their shared items.

## Prefix/suffix continuity

Adjacent local windows must describe one consistent global sequence. For a
length-`r` window, the suffix of the window at `t` should match the prefix of the
window at `next(t)`.

Generic continuity template:

```text
sum over a0 of W[t, a0, q1, ..., q_{r-1}]
=
sum over ar of W[next(t), q1, ..., q_{r-1}, ar]
```

for each shared ordered suffix/prefix `(q1, ..., q_{r-1})`.

Use cyclic wraparound only when the source formulation or task definition makes
the sequence cyclic. Otherwise handle the first and last positions with explicit
boundary logic. Even in a cyclic model, reporting metrics may use only the start
positions declared eligible by the instance.

## Overlap penalties

If the objective penalizes two or more overlapping local patterns, introduce an
overlap indicator or an equivalent linearization. Do not replace an ordered
overlap rule with an unordered span count or with all combinations inside a
larger window unless the task defines that rule.

For two overlapping local patterns represented by `A` and `B`, use:

```python
overlap <= A
overlap <= B
overlap >= A + B - 1
```

Then attach the instance-defined ordered cost to `overlap`. Keep the overlap
term inside the optimized model whenever it is part of the objective. Optimizing
a reduced model and adding the omitted high-order penalty afterward usually
optimizes a different problem.

When the prose mentions pressure, overlap, or "three in four" behavior, pause
and distinguish these common but different definitions:

- all unordered triples contained in a four-position span;
- ordered triples whose positions have span at most four;
- pairs of adjacent active three-position windows sharing positions;
- explicit auxiliary variables from a source formulation.

These are not interchangeable. Use only the definition implied by the supplied
starts, successor rules, variables, or verifier-style wording.

## Active-pattern overlap rule

For overlap penalties, first ask: "What lower-order pattern must be active?"
Do not infer an overlap term as "all combinations inside a wider window" unless the task explicitly defines it that way.

Use this workflow:

1. Build the active set of primitive ordered patterns.
2. Check overlap through membership in that active set.
3. Add only the cost specified for that overlapping pattern pair.

Generic template:

```python
active = set()
for start in eligible_starts:
    active.add(tuple(item_at_position(start, offset) for offset in primitive_offsets))

overlap_count = 0
for extended_tuple in candidate_extended_tuples:
    left = primitive_left(extended_tuple)
    right = primitive_right(extended_tuple)
    if left in active and right in active:
        overlap_count += overlap_cost(extended_tuple, left, right)
```

Common wrong shortcut:

```python
for window in all_length_4_windows:
    for triple in combinations(window, 3):
        overlap_count += triplet_count[triple]
```

That shortcut is correct only when the objective explicitly says the overlap term is all triples contained in each length-4 window.

Before implementing any overlap term, write down:

- primitive pattern;
- active-start set;
- overlap membership rule;
- overlap cost formula.

## Start-position masks and boundary rules

Many sequencing objectives score only certain starts, such as same-shift starts,
calendar-day starts, route-leg starts, or valid short-horizon starts. Keep these
masks separate from the tuple weights.

A reliable pattern is:

```python
for start in eligible_starts[component_name]:
    ordered_tuple = tuple(item_at_position(start, offset) for offset in offsets)
    component += weight_table.get(ordered_tuple, 0)
```

Do not infer additional boundary windows from prose. Use the starts, successor
rules, and component definitions supplied by the instance.

If the ordered positions are labeled, do not assume labels are contiguous
integers unless the instance says so. Build a successor map from the declared
ordered position list:

```python
ordered_positions = list(instance["all_positions"])
successor = {
    pos: ordered_positions[idx + 1]
    for idx, pos in enumerate(ordered_positions[:-1])
}
```

Then evaluate windows by following the successor relation. This avoids mixing up
slot labels with zero-based array positions.

## Objective semantics audit

Before finalizing a model or heuristic, answer these questions in code comments
or the formulation:

- What is the ordered sequence being produced?
- Are pair and tuple tables ordered, unordered, or explicitly symmetric?
- Which start positions are eligible for each component?
- What successor relation defines "next"?
- Are overlap terms all subsets, active overlapping windows, or explicit
  variables?
- Are missing tuple rows zero or invalid?

Then create a pure `evaluate(sequence, data)` function before writing outputs.
The evaluator must depend only on input data and the final sequence, not solver
variables. Use it to audit any solution found by a solver or local search.

## Common mistakes

- Modeling unordered combinations when the objective is ordered.
- Sorting or symmetrizing tuple keys without permission.
- Summing both directions of a pair because both rows exist in the input.
- Summing every permutation of a triplet because the data table is complete.
- Counting every combination inside a larger horizon instead of the defined
  sliding or overlapping windows.
- Confusing position labels with zero-based array indices.
- Creating window variables but forgetting no-repetition restrictions.
- Creating auxiliary variables without lower-bound linking constraints.
- Applying cyclic wraparound to reported metrics when only the model continuity
  is cyclic.
- Dropping high-order objective terms to make the model smaller.
