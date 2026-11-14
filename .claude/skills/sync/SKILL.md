---
name: sync
description: Bring the stories, rules, Quint model and generated TypeScript of this repository back into step. Use after any change to spec/**/*.md or src/, when the user adds or edits a story or rule, when they edit Quint by hand, or when `pnpm check` shows a ✗.
---

# Sync the spec

Read AGENTS.md in full first, once per session.

## The loop

1. Run `pnpm check`. Each `✗` line is something to resolve; `-` lines are
   stages skipped because of a `✗` above.
   Under `review` it prints a changed rule's prose and Quint, a story's text
   and rules, and a contract's `//@` lines; for a **new** rule, read it in the
   spec. The last line, `next:`, names what to do first.
2. Resolve what `next:` names, using the table below, by editing `spec/**/*.md`
   (and `src/`, the tests or a driver only when `types`, `tests` or `traces`
   asks for it, or when a story you formalized leaves the verified core: then
   search the tests for its citation and extend the journey that has it,
   AGENTS.md "Tests").
3. Run `pnpm check` again. Repeat until the only `✗` lines are `review`
   items other than **story has no rules** and **not formalized**, and `proof`
   obligations you could not prove (see below).
4. Stop and report (see "When you stop").

Give up and report after five rounds on the same failure.

## What each failure asks of you

| Report says | Translate |
|---|---|
| `review` … **document changed** | Read the title, introduction and links; confirm that they describe the spec and point to the intended children. |
| `review` … **story has no rules** | Story → rules. Under the story, write one `###` rule for each thing the story requires: a sentence a product owner would call true or false. Then write each rule's Quint. If the story makes a new kind of state possible, add a `sometimes` rule for it. |
| `review` … **new story** or **story changed** | Story → rules. Check that the story's rules, listed under it, say everything it asks for; write the missing ones. |
| `review` … **not formalized** | Rule → model. Write Quint that says exactly what the sentence says and no more. If that model then breaks a rule, the trace shows what the sentence left out. |
| `review` … **prose changed** | Rule → model. If the meaning changed, change the Quint to match. If only the wording changed, leave the Quint. |
| `review` … **model changed** | Model → rule. Someone edited the Quint. Rewrite the sentence so that a reader of the prose alone is not misled. |
| `review` … **model changed through** … | Model → rule. The Quint of a rule this one relies on changed; the report names its definitions and rule when it can. Check that this rule's sentence is still true of them; rewrite it if not. |
| `review` … **prose and model both changed** | Read both halves and make sure they moved to the same place. |
| `review` … **new** | Read the rule's prose and Quint in the spec and make sure they say the same. |
| `review` … **removed or renamed** | A rule: check that no story still depends on it. A story: check that its rules moved with it or went too. |
| `review` … **new contract** or **contract changed** | Read the `//@` lines printed under `src/`. Check they say what the code must do, and no less than the rules it serves. |
| `review` … **cited by** `file:line` | The rule's meaning moved, and that test or shell line cites it. Read each again against the rule as it is now; change an assertion only where the rule now asks for something else, and name it in your report. |
| `review` … **contract removed** | A `src/` file lost its last `//@` or was deleted. Check that nothing still relies on what it proved. |
| `model` | Fix at the reported `spec/…:line:col`. AGENTS.md lists what Quint is supported and which names are refused. |
| `always` with a trace | Model → rule. The trace reaches a state that breaks the named rule; its last lines name the event and its guard. Decide whether the user would want that trace forbidden. If so, write the **reason** as a new rule and guard, such as "a payment may not exceed the balance". Only if you cannot find the reason, use the fallback the report offers: refuse the event when its result would break the rule. If the trace is fine and the `always` rule is wrong, fix the rule and say so. |
| `always` in a nightly check | The fixed nightly profile found it. Treat it as any other trace; the printed command repeats it. |
| `always` … "the law … is false for" | The law or the function is wrong for those arguments. Fix whichever does not say what the prose says. |
| `always` … "the simulator could not run" | A definition failed while being evaluated: usually a list index out of range, a missing map key or a division by zero. Guard it in the definition that uses it. |
| `sometimes` not reached | A guard is too strict, a transition is missing, or the goal needs values the simulator does not try (define `<param>Values`). |
| `sometimes` … **never happened** | The guard refused its event in every state reached, so every rule holds of it trivially and the story behind it may be impossible. Find which clause never holds: loosen the guard, add the transition that leads to the states it needs, or define `<param>Values` that it allows. If the event can only happen after more than 100 events, say so in your report; do not remove the event or weaken the guard to make the check pass. |
| `sometimes` ✓ … **never seen to refuse** | Not a failure. For each guard listed, check that it refuses what its rule says. If it only restates an `always` rule, keep it when it protects `enabled` from outside input; if it was meant to refuse something, write what, or define `<param>Values` that it refuses. List these guards in your report. |
| `replay` | Generated TypeScript and Quint disagree. That is a bug in the tools, not in the spec. Stop and report it. |
| `types` | Update `src/` and the tests to the new generated contract. The compiler is `vibelang` (the `shell` skill): `.vibe`, `.ts` and `.tsx` are checked together, and an `EK…` error ends with its repair. |
| `proof` … "only .ts files under src/ are proved" | A `//@` in a `.vibe` file or another script. Move what it specifies into a `.ts` file, or remove the annotation. |
| `types` … no tsconfig.json | Run `spec init` to add one. A spec-only package passes without one (✓). |
| `proof` … "not proved" | It holds in simulation; it is yours to prove. First decide whether it is true for every state that satisfies all the rules. If it is not (you can name such a state), no proof can help: the missing fact about reachable states becomes a new `always` rule, a discovered rule. If it is, prove it in the unit's proof file, `spec/<path>.proof.dfy` or `src/<path>.proof.dfy`: copy the obligation's `lemma …_ensures` header from `gen/proof/<unit>/<unit>.dfy` and write its body, calling `ProofLib` lemmas and your own helper lemmas (the `prove` skill, "Proof files"). Only what you cannot prove goes in your report, with what you tried; recording it as simulated only is the user's last resort, not yours. |
| `proof` … "Dafny could not check it" | The generated or hand-written code is not something Dafny accepts (an unguarded lookup, index or division, or a wrong annotation), or the proof file is refused or does not verify: a stale header, a forbidden construct, a helper lemma that fails. The lines under it say which, with the file and line. |
| `proof` … "belongs to no proof unit" | A stray proof file. Rename it to `spec/<path>.proof.dfy` for `spec/<path>.md`, or `src/<path>.proof.dfy` for a `src/<path>.ts` that contains `//@`; or delete it. |
| `proof` … "the proof stage needs Dafny 4.11 on the PATH" | Dafny is missing or not 4.11.x. Tell the user; do not work around it. |
| `proof`, a `src-…` unit | Fix the hand-written code, its `//@` annotation, or its proof file. The full output is in `gen/proof/<unit>.log`. |
| `tests` … citations name no story or rule | Cite the story or rule by its heading as the spec now has it. If it was removed, the test that cites it is yours to review: does any rule still ask for what it checks? |
| `tests` … **cite no story or rule** | Cite the story or rule each listed test serves: on the test, on the `describe` or layer around it, or in the file's header. If it serves none, fold what it checks into the journey that does, or propose deleting it. |
| `tests` … **touch only generated code** | The test checks what the spec proves. Route it through the `src/` code a user's input reaches, as a step of the journey it belongs to, or propose deleting it. An import added only to pass is a workaround. |
| `tests` … **a driver imports gen/ as types only** | The listed `test/drivers/` line imports the oracle it is compared with. Reach the application through its own entry point, and import from `gen/` with `import type` only. |
| `tests` … "generated tests: … no test" | A `src/**/*.schema.*` or `*.contract.*` module yields no property test; the lines say why. Make it export an Effect Schema whose values can be generated, or a `contract({ … })` that declares a property; or rename it if it is neither. |
| `tests` ✓ "test/ had nothing to run it: added …" | Not a failure: `check` gave the package the `test` script and Vitest configuration `spec init` writes. Keep them; install if Vitest is missing. |
| `tests` ✓ `note:` … consolidate | Two test files for one runner and language, or one of 15,000 lines: merge them, extending journeys rather than repeating setup, when you next work there. List it in your report. |
| `tests` ✓ `note:` no test or driver checks … | A story of that spec that leaves the verified core needs a journey that cites it, and a shell that keeps the machine's state a driver. If none does, say so in your report. |
| `tests` … fail | Fix the application in `src/`. Change an assertion only where the spec now asks for something else, and name the assertion and its rule in your report. A test that only restates what the spec proves, or breaks AGENTS.md "Tests", you propose for deletion in your report; never delete one to make it pass. |
| `traces` … **the program departs from the spec** | The application in `src/` disagrees with the spec on the printed trace or probe. A probe of a malformed input means the shell takes input without `decodeEvent`, or keeps what it read without copying it. Fix the application; if the spec is what is wrong, change the rule and say so. Never edit a recorded trace or a saved counterexample to pass. |
| `traces` … **saved the counterexample** `test/counterexamples/…` | A journey or walk disagreed, and its shrunk trace is now replayed first on every run. Decide which side is wrong: the application, if the spec says what the user wants; else the rule, and say so. Keep the file and list it in your report: it is a regression test. |
| `traces` … **the run did not get as far as comparing** … "fill in reset, dispatch and observe" | `check` wrote this driver because `src/` keeps the machine's state. Write `reset`, `dispatch` and `observe` on the application's own entry point (SPEC.md, "Conformance"), and `receive` if the shell decodes untrusted input. |
| `traces` … **the run did not get as far as comparing** … "the spec has outgrown" | A saved counterexample sends an event the spec no longer has. Rewrite its events to what the spec now calls them, or delete the file if what it caught is gone, and say which in your report. |
| `traces` … **the run did not get as far as comparing**, otherwise | The driver could not run: it threw, exports no `driver`, did not finish, or is named after no state machine. The lines under it say which; fix that. |
| "another check or accept is running" | Wait for that process and run again. If it no longer exists, delete the lock file the message names. |

## Rules for what you write

- Prose and Quint are two statements of the same rule. Neither is senior: the
  half that changed last is the one the user meant.
- Quint is only read from blocks under a `###` rule. If you add a definition
  to an existing rule's block, check that the rule's sentence still covers it;
  otherwise give it its own rule.
- A rule that the checks forced, and that the user did not write, goes under
  the story it belongs to, in the user's vocabulary, with a sentence beginning
  "Discovered by simulation:" or "Discovered by the proof:" that says what
  went wrong without it.
- Everything in [AGENTS.md](../../../AGENTS.md), "Hard rules", applies.

## When you stop

Tell the user, in this order:

1. **Rules added** from their stories.
2. **Rules discovered** by the checks, each with what went wrong without it.
   These need their confirmation most.
3. **Rules changed**, and which half you changed to follow the other.
4. **Proved by hand**: proof files you wrote or changed, and which
   obligations they prove.
5. **Tests**: journeys added or extended, each with what it covers that the
   checks cannot (search the tests for a rule's citation before adding one:
   extend the journey that has it), drivers written, counterexamples saved
   and which side you fixed, and tests you propose to delete.
6. **Not proved**: obligations that hold in simulation only, if any, each
   with why you could not prove it.
7. **Could not formalize**: anything in a story you left out, and why.

Then ask them to read the diff of `spec/`, `src/` and the tests and run `pnpm accept`.
