# @repo/app

Hello world: a page that greets a name and counts the greetings. It is small on purpose, and it uses one of each
thing Vibestack offers, so that every stage of `pnpm check` has something to check. Start a new application by
replacing it.

Its requirements are [`spec/app/index.md`](../../spec/app/index.md), in the one spec tree at the repository root.
`pnpm check` there generates `gen/app.ts` and `gen/app.effect.vibe` here, and checks this package's types, proofs,
tests and traces (SPEC.md, "One spec tree").

| Piece | Shows | Checked by |
|---|---|---|
| `spec/app/index.md` | a story; a state, `initial`, a guarded transition, an `always`, a `step`, a `sometimes` rule and a law | `model`, `always`, `sometimes`, `replay`, `proof` |
| `src/greeter.vibe` | the VibeLang shell: the greeter kept in a `KeyValueStore`, every input through `decodeEvent` and `apply` | `types`, `traces`, `tests` |
| `src/greeter.schema.ts` | an Effect Schema at the boundary: what the store holds | the property tests `pnpm test` derives from it |
| `src/greeting.ts`, `greeting.proof.dfy` | hand-written verified logic: a `//@` contract and the lemma that proves it | `proof`, `review` |
| `src/App.tsx`, `src/useGreetings.ts` | React over the shell: Greet is offered exactly when `enabled` allows it, on `@repo/ui` and the design tokens | `types`, lint, `test:browser` |
| `test/drivers/app.ts` | the conformance driver: the shell against the spec, by journeys, malformed inputs and random walks | `traces` |
| `test/app.test.vibe` | the journey the driver cannot see: the greeter read back from its store | `tests` |
| `test/app.browser.test.tsx` | what only a browser shows: focus after greeting, and a full localStorage | `pnpm test:browser` |

| Command | Does |
|---|---|
| `pnpm dev` | the app, with Vite |
| `pnpm typecheck`, `pnpm build` | `vibelang --noEmit`; `vite build` to `dist/` |
| `pnpm test`, `pnpm test:browser` | the tests in Node, with the derived property tests; the browser tests in Chromium |
