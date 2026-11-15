---
name: prove
description: "Prove what `pnpm check` could not: read before working on a `proof` stage ✗, writing or changing a `spec/<path>.proof.dfy` or `src/<path>.proof.dfy`, or writing a `//@` file of hand-written verified logic under `src/`."
---

# Prove an obligation

## When a proof does not go through

Dafny proves arithmetic and simple list facts on its own. It usually cannot
prove a rule that depends on a fold, a count or a search without help. When
`proof` lists obligations as "not proved" although simulation found nothing,
for each one, in this order:

1. **Prove it** in the unit's proof file (next section). This is the agent's
   work, like any other translation.
2. **State the missing fact**, if the obligation is false for some state that
   satisfies every rule: no proof can help then. Add it as an `always` rule
   or a law (the inductiveness case in [SPEC.md](../../../SPEC.md#writing-good-rules), "Writing good rules"). Moving arithmetic into a small
   function with a law in a library spec, or writing a loop by hand in
   `src/`, also gives Dafny smaller steps.
3. **Accept simulation for it**: the user's decision, never the agent's, and
   only for a spec unit: nothing simulates hand-written code, so a `src`
   unit's obligations must be proved.
   `pnpm accept unproved` records the obligations in
   `spec/lock.json` under `unproved`, per unit, with a fingerprint of the
   unit's text and proof file. The check then passes and says how many obligations are
   simulated only. It fails again if a *new* one appears, or if the unit or
   its proof file changes: what was accepted for one text does not carry over
   to another. Read the list before recording it: an obligation that is false
   is also "not proved".

Counting is per obligation. Dafny verifies each definition whole, and one
that fails again with every assertion on its own; a failing `ensures` is never
assumed while another is checked. The prover works to a fixed resource limit
(`RESOURCE_LIMIT` in `vibestack/prove.ts`, per definition and then per assertion)
rather than a time limit, so the answer does not depend on the machine. An obligation it
could not finish is marked `[the prover ran out of resources]`. A lemma
assumes what every lemma it calls ensures, so an obligation whose proof calls,
directly or through helpers, a lemma with an obligation not proved is not
proved either, and is marked `[rests on <that obligation>]`; the body the
tools give `step_ensures` is no exception. The total is the number of
`ensures` in the unit's generated Dafny. A proof line that relies on
obligations simulated only lists them.

## Proof files

A unit's proof file sits beside it: `spec/billing/index.proof.dfy` proves
`gen/billing.ts`, `src/<path>.proof.dfy` proves `src/<path>.ts`. A proof file that
belongs to no unit is reported.

**What the prover sees** is `gen/proof/<unit>/<unit>.dfy`, written by every
`pnpm check`, and Dafny's full output is `gen/proof/<unit>.log`. The file
is, in order: what LemmaScript generated (the modules the unit imports, with
names prefixed `<module>_` and without their obligations, then the unit
itself), the bodies the proof file supplied, the lemmas the tools add, the
proof file's helpers, and the library. Each obligation is one `ensures` of a
generated `lemma <fn>_ensures`: for a transition, one per `always` and `step`
rule, each conditional on `inv` and the guard; for a law, `<law>(...) == true`.

**Grammar.** A proof file holds only `lemma` declarations, each with a body,
and `//` comments. Anything else is refused with its file and line. A lemma
runs to the next `lemma`, and its body is the brace group it ends with, after
a complete header: the set display in `decreases {0}` or `x in {1}` is never
a body.

- A lemma named like a generated `<fn>_ensures` supplies that lemma's body.
  Its header must repeat the generated one exactly; copy it from the `.dfy`
  (whitespace and comments do not matter). When a rule changes, the header
  changes, and the old body is refused as stale.
- Any other lemma is a helper, added after the generated text. Its name must
  not be one the `.dfy` already declares.
- Inside bodies: `assert`, `assert … by`, `calc`, `forall … ensures`, `if`,
  `match`, `var`, `reveal`, calls to lemmas, and the attributes `{:trigger}`
  and `{:induction}`.
- Names from Dafny's standard library (`Std.…`) only as the generated code
  writes them, such as `Std.Collections.Seq.Filter`: the library holds axioms,
  and `dafny audit` does not report them in the unit. `ProofLib.<Name>` only
  for what `vibestack/proof/lib.dfy` declares.
- Refused: block comments, `@`, any other attribute, character literals, NUL,
  anything but ASCII outside comments and strings, and the words that
  declare or trust something: `assume`, `expect`, `function`, `predicate`,
  `method`, `ghost`, `const`, `type`, `datatype`, `include`, `import`,
  `module`, `reads`, `modifies`, `opaque`, `axiom`, `verify` and the rest of
  `FORBIDDEN` in `vibestack/prove.ts`.
- After that, LemmaScript refuses the `.dfy` unless it is its own output plus
  added lines, and `dafny audit` refuses anything assumed rather than proved.
  A failure anywhere but in a generated definition (a helper, the library, a
  lemma the tools add) fails the unit; it is never counted as an obligation.
  The tools know which definition each line of the `.dfy` belongs to from
  where they put it, and read only Dafny's own messages: at the start of a
  line, without source lines echoed, and as many as Dafny counted.

**What a proof can call:**

- `ProofLib.<Name>(...)` from `vibestack/proof/lib.dfy`, of which every unit that
  has a proof file gets what the file calls and what that uses: `Filter` (a heap-free view of `Std.Collections.Seq.Filter`,
  see below), `Distinct`, `DistinctBy`, and lemmas about filters
  (`FilterNil`, `FilterCons`, `FilterAppend`, `FilterMember`, `FilterSubset`,
  `FilterNone`, `FilterOne`, `FilterTwo`, `FilterCountOneIffUnique`,
  `FilterDistinctCountOne`, `FilterKeepsDistinctBy`, `FilterLengthPointwise`,
  `FilterPointwise`, `FilterSamePredicate`, `FilterImpLength`,
  `FilterOfFilterLength`, `FilterOfFilterShorter`), distinctness and sets
  (`DistinctByConcat`, `SubsetCard`) and folds (`FoldLeftAppend`,
  `FoldLeftInflationary`, `FoldLeftAboveEach`, `FoldLeftMax`,
  `FoldLeftPointwise`, `FoldLeftConcatEmpty`, `FoldLeftConcatMember`,
  `FoldLeftConcatDistinctBy`, `FoldLeftDedupMember`, `FoldLeftDedupDistinct`).
  Read the file for what each states. A lemma general enough for any project
  belongs there, with its proof; one about your spec belongs in your proof
  file.
- What an imported module's own unit proved in the same run, neither
  simulated only nor resting on an obligation that is: its lemmas
  `<module>_<fn>_ensures(args)` for each law, transition, `step` and
  `initialHolds`, with the clauses proved. `<module>_<law>_ensures(args)`
  gives `<module>_<law>(args) == true`, and `<module>_<transition>_ensures(s, …)`
  gives each rule of that module for `<module>_<transition>(s, …)`, under its
  `inv` and guard, so a machine that holds another need not prove its rules
  again (`vibestack/fixtures/office.md`). (In a `src` unit, those of the module
  it imports are `<fn>_ensures`.)
- The laws of the unit's [opaque functions](../../../SPEC.md#opaque-functions), assumed:
  `<law>_ensures(args)`.
- The generated `_ensures` lemmas, and Dafny's standard library by the names
  the generated code uses.

`step_ensures` gets a body from the tools that calls each transition's lemma;
supply one to replace it.

**Two Dafny facts** shape most proofs about lists:

- `Std.Collections.Seq.Filter` is opaque and reads the heap, so a fact about it
  proved in a lemma does not meet the same call inside a generated rule.
  State facts about `ProofLib.Filter`, and connect them to the rule with a
  helper whose `ensures` is the rule's body with `ProofLib.Filter` in place of
  `Std.Collections.Seq.Filter`; it proves with an empty body:
  `lemma KeysFilter(r: Registry) ensures alwaysAKeyNamesOneProject(r) == !(exists a :: a in r.entries && !(|ProofLib.Filter((b: Entry) => (b.key == a.key), r.entries)| == 1)) { }`.
- A lambda is the same term only if it is the same text: pass the lambda the
  generated code uses, copied verbatim from the `.dfy`.

**To prove an obligation:**

1. Find its lemma in `gen/proof/<unit>/<unit>.dfy` (the check names the
   definition and the clause).
2. Copy the lemma's header into the proof file and write a body. For a
   transition, the usual shape is
   `if inv(s) && canX(s, …) { var after := x(s, …); …facts about after… }`.
   Where a unit has obligations not proved, `pnpm check` also writes
   `gen/proof/<unit>/<unit>.scaffold.dfy`: each such lemma without a body
   yet, with its exact header and a body to start from. Copy from it.
3. Run `pnpm check`. Dafny's messages point into the `.dfy`; the log has
   them all.

`vibestack/fixtures/highest.md` is the smallest example: its law needs induction
over a fold, and `vibestack/fixtures/highest.proof.dfy` proves it (the selftest runs it):

```dafny
lemma lawTheHighestIsAtLeastTheStart_ensures(xs: seq<int>, start: int)
  ensures (lawTheHighestIsAtLeastTheStart(xs, start) == true)
{
  ProofLib.FoldLeftMax((top: int, x: int) => (if (x > top) then x else top), start, xs);
}
```

## Hand-written verified logic

Put logic in the spec when you can: it is then simulated, proved and
generated. For pure logic that Quint cannot express, such as a loop over an
event log, write TypeScript under `src/` with
[LemmaScript](https://github.com/midspiral/LemmaScript) annotations.
`vibestack/examples/order/src/ledger.ts` is the worked example.

- Any `.ts` file under `src/` that contains `//@` is proved by
  `pnpm check`, as the unit `src-<path>`; under an owner's `src/`, as
  `apps-<name>-src-<path>`, against the module in the owner's `gen/`. Its
  `//@` lines are its contract, reviewed like a rule (see [Review](../../../SPEC.md#review)).
- Such a file may import one generated module and nothing else, and only by
  name: no `as`, default or namespace import. Its annotations may mention
  anything that module defines (`inv`, guards, rules), imported or not.
- At the top level it may hold only imports, functions with a body,
  interfaces, type aliases and `const` declarations, each exported in its own
  declaration (`export function`, `export const`, …) or not at all: no
  `export { … }`, `export default` or statements. The proof reads names as
  written, and LemmaScript does not model what such statements do at run time.
- `//@` must be in a `//` comment, never in a block comment or a string. In
  any other script under `src/` (`.vibe`, `.vibex`, `.mts`, `.cts`, `.tsx`, `.js`, `.jsx`,
  `.mjs`, `.cjs`) it is an error.
- Allowed annotations: `backend`, `pure`, `requires`, `ensures`, `invariant`,
  `decreases`, `type`, `ghost`, `assert`. Any other, such as `assume`,
  `extern`, `havoc`, `skip` or `verify`, is refused wherever on a line it
  appears.
- Keep I/O, classes and libraries out of these files; put them in the shell.
- When a proof fails, the summary names the function and the annotation, and
  the full Dafny output is in `gen/proof/<unit>.log`. A proof that needs more
  than annotations goes in `src/<path>.proof.dfy` (see "Proof files").
- Such a unit is proved against the definitions of the module it imports.
  If that module has obligations that are simulated only, its proof line says
  that it is proved assuming them, and lists them. Its own obligations must
  be proved.

Tests for the shell: see [AGENTS.md](../../../AGENTS.md#tests), "Tests".
