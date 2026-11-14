# Assistant

An illustrative agent turn driving a bill payment, starting at
[spec/index.md](spec/index.md), and the agent loop around it.

```sh
pnpm install --ignore-workspace   # here, after the install at the repository root
pnpm check   # model, proofs, types (vibelang --noEmit) and tests
pnpm test    # the journey alone: vitest run
pnpm build   # vibelang: JavaScript in dist/
pnpm demo    # generates gen/, and a scripted model pays a bill, then tries what the rules refuse
```

| Behaviour | Rule |
|---|---|
| Every model choice spends a bounded budget | `stepChoicesSpendBudget`, `alwaysBudgetBounded` |
| The sender comes from the session, never the message | `by`; `step(s, e, by)` |
| A late reply is refused, before or after a restart | `stepReplyAnswersWaiting`, `stepRequestNeverGoesBack` |
| A bill is reviewed, then paid once, after the person's confirmation | `alwaysPaidOnlyReviewed`, `alwaysChargedOnce`, `stepChargedOnlyOnConfirm` |
| Confirming submits the bill's amount, once, on the biller's own page | `confirm` returns `Submitted`; `stepSubmittedWhenCharged` |
| Only the person saves the card | `canSaveCard`, `stepCardOnlySaved` |
| Card details and payment go only to the biller's own page | `stepFilledOnlyGenuine`, `stepPaidOnlyOnGenuine` |
| The model cannot have the card read aloud | `SecretCard`: no secret reaches what is said |
| The program carries out what each choice outputs | `choose` returns `{ state, out }` |

| Need | How |
|---|---|
| Termination | a budget every choice spends, and `leadsToPlanningEnds` under fair choosing |
| Requests in flight | a request number, saved |
| Crash and restart | `restart`, sent by the world, resets what is not saved |
| Delivery after a crash | a persisted queue and stable delivery numbers; the world applies each number once |
| The model and the world as adversaries | their choices are event parameters; the simulator tries every sender |

## The shell

The shell is [VibeLang](https://github.com/smithersai/vibelang): Effect in
TypeScript syntax, in `.vibe` files. `pnpm gen` writes
`gen/assistant.effect.vibe` beside the generated module, and the shell is
built on its `Machine` service: every event reaches the state through
`send(event, by)` or `receive(input, by)`, which fail with `Rejected` or
`NotAnEvent` where the rules or the parser refuse.

| In `src/agent.vibe` | Is |
|---|---|
| `Model` | the model as a service: `choose(seen)` returns an untrusted answer, or fails with `NoAnswer` |
| `World` | the biller and the browser as a service: `bill(request)`, `page()`, `perform(delivery, effect)`; retries return the same success without repeating the action |
| `remember(card)` | the card the person saves, sent as the Person |
| `deliver()` | drains saved effects oldest first, acknowledging each only after the world confirms it; call it on startup to finish interrupted work |
| `hear(said)` | what the person said, sent as the Person, and what it output carried out (a confirmation's payment); then the loop: the model's answer offered as the Agent's choice, what that choice output carried out, the page and the biller's answer sent as the World. It returns where the turn stopped and each answer that ended it, and fails with `Rejected` when the rules refuse the person |

An answer of the model that is no choice the rules allow, or no answer at all,
finishes the turn, so a turn makes at most four passes whatever the model
says.

`src/durable.vibe` is `opened(file)`, a `Machine` kept in one JSON file
through Effect's `FileSystem`, and `durable(file)`, the same as a layer:
opening it reads the file (a missing one is `initial`, one that is no state
fails with `NotAState`) and applies `restart` from the world; each accepted
event is written to a temporary file, synced to the disk and renamed before
`send` returns, one event at a time. The card, pending effects and last
acknowledged delivery number are saved there too, since the spec says they
survive a restart. It is for one process: nothing locks the file, so two
processes would overwrite each other.

`src/scripted.vibe` is a `Model` and a `World` that follow a script. The demo
and [the journey](test/assistant.test.vibe) share it: a real model costs
money, so it is faked at its service. `src/demo.vibe` prints one scripted
bill payment.

What stays TypeScript is `gen/assistant.ts`, which the proofs are about. This
example has no hand-written file with `//@` contracts.

The main journey runs on `durable` in a temporary directory. It crashes first
while a lookup waits for the biller: after the restart nothing waits, the late
reply is refused and the next lookup takes the next request number. It pays,
crashes again and finds the payment kept and the turn restarted; a file that
claims a second charge, or is cut short, is refused.
[The driver](test/drivers/assistant.ts) lets `pnpm check`'s traces stage run
the spec's journeys, malformed inputs and random walks through `opened(file)`
on a real file, the effects included, and makes each accepted restart a real
one: the machine dropped and opened again.

Every emitted effect is queued in the same state update that records its
decision. Delivery uses the next saved number, and only a successful reply
removes the oldest effect. A crash before the reply retries the same number;
`World.perform` must implement idempotency for that number within the
assistant's account. The scripted world demonstrates that contract. A real
provider must supply the equivalent guarantee; this example has no live
`Model` or `World`.

Saved files from before the delivery queue was introduced lack its required
fields and are refused by `decodeState`. No migration can recover an effect
that the old format never recorded. The demo keeps its state in memory.
