---
name: shell
description: "Write the code around the generated core: read before writing or changing anything in `src/` or a test, in VibeLang (`.vibe`) or React (`.tsx`), and before importing `gen/<name>.effect.vibe`, building or running the application."
---

# The VibeLang shell

The shell around the generated code is
[VibeLang](https://github.com/smithersai/vibelang): `.vibe` files, TypeScript
syntax over [Effect](https://effect.website) 4, in which a function's type
says what it fails with and which services it needs. Every package depends on
the `vibelang` compiler: `types` runs `vibelang --noEmit -p .`, which checks
`.vibe`, `.ts` and `.tsx` as one program, and `gen` writes
`gen/<name>.effect.vibe` beside each `gen/<name>.ts`.

**Before writing any**, read the skill the compiler ships,
`node_modules/vibelang/skills/vibelang/SKILL.md`. The language is new: look
syntax and Effect APIs up, and compile often.

## The Effect adapter

`gen/<name>.effect.vibe` is `gen/<name>.ts` for effect code. Import it in
place of the `.ts` module: `"../gen/index.effect.vibe"`.

| It exports | Which is |
|---|---|
| every type of `gen/<name>.ts` | the same types |
| its constants and functions, under their own names: `initial`, `step`, `enabled`, `parseEvent`, your guards, helpers and rules | the same, declared to throw nothing, so effect code calls them bare: `canPay(order, 5)`. The compiler refuses that call (EK0403) when the function is imported from `gen/<name>.ts` |

and for a state machine, with `[, by]`, `NotASender` and `decodeSender` only
when the spec has a sender:

| It exports | Which is |
|---|---|
| `error Rejected { event, state[, by] }` | the rules do not allow this event in this state |
| `error NotAnEvent { input }`, `NotAState { input }`, `NotASender { input }` | an untrusted value that is not one |
| `decodeEvent(input)`, `decodeState(input)`, `decodeSender(input)` | `parseEvent`, `parseState` and `parseSender`, failing where they return `undefined` |
| `apply(current, event[, by])` | `step`, failing with `Rejected` where `enabled` refuses instead of leaving the state unchanged |
| `service Machine` | the state and the one way to change it: `get()`, `send(event[, by])`, `receive(input[, by])` for an untrusted event (`decodeEvent`, then `send`), and `changes`, a `Stream` of the state, starting with the current one |
| `machine(start = initial)` | a `Layer` that provides `Machine` in memory, applying one event at a time; `start` may be a state `decodeState` returned |
| `machineOver(start, keep)` | an effect that makes a `Machine` from `start` which gives each new state to `keep` before it is current; `send` dies, and the state stays, where `keep` dies. A shell that keeps the state elsewhere, such as a file, supplies only how to load and `keep` it |
| `stored(key, start = initial)` | a `Layer` that provides `Machine` kept as JSON under `key` in Effect's `KeyValueStore` (`effect/persistence/KeyValueStore`): it starts from what is stored, through `decodeState` (failing with `NotAState`, and never writing over it, where that is not a state), or from `start`; each new state is stored before it is current, and `send` dies where the store refuses it |

Where transitions return `{ state, out }`, `apply`, `send` and `receive`
return that record; `get` and `changes` give the state.

A shell and its test, on the order example's spec:

```vibe
// src/app.vibe
import { Machine, NotAnEvent, Rejected, canSubmit } from "../gen/index.effect.vibe"

/** What to tell the sender of an untrusted input. Needs a Machine, which the caller provides. */
export effect function answer(input: unknown) {
  const orders = try Machine
  return effect {
    const order = try orders.receive(input) // decodeEvent, then apply: the state changes only if both pass
    return canSubmit(order) ? "ready to submit" : order.status // a guard of the spec, called bare
  } catch (error) => match (error) {
    when NotAnEvent: "not an event";
    when Rejected: `${error.event.type} is not allowed for a ${error.state.status} order`;
  }
}
```

```vibe
// test/app.test.vibe
// spec/index.md, "Story: Check out"
import { assert, it } from "@effect/vitest"
import { machine } from "../gen/index.effect.vibe"
import { answer } from "../src/app.vibe"

it.effect("Check out", effect () => {
  provide machine() {
    const said = [try answer({ type: "addItem", qty: 2 }), try answer({ type: "pay", amount: 1 }), try answer("pay")]
    try Effect.try(() => assert.deepStrictEqual(said, ["ready to submit", "pay is not allowed for a Draft order", "not an event"]))
  }
})
```

- **`machine()` forgets when the process ends; `stored(key)` keeps the state**
  in the `KeyValueStore` layer the program provides (`layerFileSystem(dir)` on
  Node, `layerStorage` in a browser, `layerMemory` in a test). Never restate
  the state as an Effect Schema. A shell that keeps it any other way, on
  `machineOver` or on `apply` and the decoders, needs a driver that `check`
  compares with the spec ([SPEC.md, "Conformance"](../../../SPEC.md#conformance)):
  `check` writes one to fill in when `src/` imports `apply`.
- **Match an event by its `type`**: `match (event.type) { when "pay": …; }`.
  The compiler does not yet check that a `match` on the event itself, or on
  a variant by its `tag`, covers every case.
- **A `.vibe` file reaches the platform through Effect**, not through
  `node:*` imports, `console`, `fetch` or the DOM: an Effect service
  (`Console`, `FileSystem`, `HttpClient`, …), a `module node { … }` body in
  the file, or a thin `.ts` file beside it.
- **`//@` files stay `.ts`** ([prove skill](../prove/SKILL.md)). Effect code
  calls one through a `module` body that says what its functions throw.

## The React interface

Components are `.tsx` under `src/`, built with Vite. A component reads the
state and sends events through hooks over the `Machine` service, so what it
shows is the spec's state and what it can do is what `enabled` allows: a
control is offered exactly when its event is. It keeps in `useState` only
what the spec does not own, such as an open menu or a draft in a text box.

In a package that depends on `react`, `gen/<name>.react.ts` exports, for each
state machine, `useMachine(runtime)` over a `ManagedRuntime` that provides
`Machine`. It returns `{ state, cause, can(event[, by]), send(event[, by]) }`:
`state` is undefined until the machine has published one, `cause` is what
stopped it (such as a `stored` layer that could not read its key), `can` is
`enabled` in that state, and `send` resolves with the `Exit` of
`Machine.send`. Offer a control exactly when `can` holds; never hand-write a
hook over `changes`.

Style with Tailwind utilities on the project's tokens, compose shadcn/ui
components before writing one, and follow the
[design skill](../design/SKILL.md).

## Building, running and testing

| | Command | Does |
|---|---|---|
| check | `pnpm check` | `types` checks `src/`, `test/` and `gen/` with `vibelang --noEmit -p .` |
| build | `pnpm build` (`vibelang`) | checks, and writes JavaScript to `dist/`, as `dist/src/…` and `dist/gen/…` |
| run | `pnpm build && node dist/src/main.js` | runs the built `src/main.vibe` |
| test | `pnpm test` (`vitest run`) | `test/**/*.test.vibe`, written with `@effect/vitest`, and the property tests of `src/**/*.schema.*` and `*.contract.*`; compiled as they load, no build first ([AGENTS.md, "Tests"](../../../AGENTS.md#tests)) |

| Needs | |
|---|---|
| Node | 26 |
| `dependencies` | `effect`, `@effect/platform-node`, `vibelang-runtime` |
| `devDependencies` | `vibelang`, `vibelang-vite`, `vite`, `vitest`, `@effect/vitest`, `@types/node` |

VibeLang's packages move together, and with one version of Effect: pin them
exactly, at the versions in the tools' own `package.json`, which `spec init`
adds. The compiler writes declarations for other tools under `.vibe/`, even
when it only checks: keep it out of Git, like `dist/`.
