# Order checkout

Draft, instalments, take-back, hold, cancel and reopen.

```sh
pnpm install --ignore-workspace   # here, after `pnpm install` at the repository root for the tools
pnpm check
pnpm demo
```

Run them from this directory: the example is a package of its own, with its
own lock file.

| Command | Does |
|---|---|
| `pnpm check` | Everything: model, simulation, proofs, types, the tests below, the order book against the spec through `test/drivers/index.ts`, review |
| `pnpm demo` | Generates `gen/` and prints a scripted checkout, run from source |
| `pnpm build` | `vibelang`: typechecks `.vibe` and `.ts` together and writes JavaScript to `dist/` |
| `pnpm test` | `vitest run`: the journey in `test/app.test.vibe`, compiled by `vibelang-vite` |

| Path | Role |
|---|---|
| `spec/index.md` | Stories, rules and the Quint checkout model |
| `spec/lock.json` | Review ledger for this example |
| `gen/index.ts` | The verified core, generated |
| `gen/index.effect.vibe` | The same core for Effect code, generated: `apply`, `decodeEvent`, and the failures `Rejected` and `NotAnEvent` |
| `src/ledger.ts` | Event replay and balance, with proved contracts |
| `src/app.vibe` | The `OrderBook` service: order storage, input decoding and rejection reporting |
| `src/demo.vibe` | Scripted checkout session |
| `test/app.test.vibe` | A checkout journey through the real shell |
| `test/drivers/index.ts` | How `check` reaches the order book: every journey, malformed inputs and random walks, compared with the spec; a disagreement is saved to `test/counterexamples/index/` and replayed first |

## VibeLang and TypeScript

The shell is [VibeLang](https://github.com/smithersai/vibelang): TypeScript
syntax in which an `effect` function returns an [Effect](https://effect.website),
`try` runs one and `throw` fails with a typed error. `OrderBook` is a service
with one layer, `OrderBookMemory`. `dispatch(id, input, by)` takes who sent the
input, a `Shopper` or `Staff`, from the caller, which knows it from how they
signed in, never from the input. It fails with `NotAnEvent` for input that is
not an event and `Rejected` for an event the rules refuse, so a caller cannot
forget either case, and the book takes one event at a time.

Two things stay TypeScript:

- `gen/index.ts` is what the proofs are about. `gen/index.effect.vibe` only
  calls it.
- `src/ledger.ts` carries `//@` contracts, which LemmaScript and Dafny prove
  from TypeScript. `src/app.vibe` calls it through a `module` body, the one
  place a `.vibe` file states what a TypeScript function throws.

`demo` runs `src/demo.vibe` from source with `node --import vibelang/register`.
`dist/` and `.vibe/` are build output.
