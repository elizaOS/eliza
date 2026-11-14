# Team task dashboard, modelled

Tasks in a shared spreadsheet, edited by hand and through a chat dashboard.

```sh
pnpm install --ignore-workspace   # here, after `pnpm install` at the repository root for the tools
pnpm check                        # model, proofs, types (vibelang --noEmit), tests and review
pnpm test                         # the journeys alone: vitest run
pnpm build                        # vibelang: JavaScript in dist/
```

Run them from this directory: the example is a package of its own, with its
own lock file, outside the root workspace.

The shell is [VibeLang](https://github.com/smithersai/vibelang): Effect in
TypeScript syntax, in `.vibe` files. `pnpm gen` writes an adapter
`gen/<name>.effect.vibe` beside each generated module; the shell takes the
tracker's types from its adapter, and the test drives that adapter's `Machine`.

| Path | Kind | Covers |
|---|---|---|
| `spec/kernel.md` | library | New row numbers, when an edit is announced, which reminder is due, list paging, request freshness |
| `spec/tracker.md` | state machine | One project's sheet: guarded dashboard edits, unguarded hand edits, warnings and their fixes, notifications |
| `spec/projects.md` | state machine | Projects: one sheet each, one per chat channel, never guessed |
| `spec/*.proof.dfy` | proofs | Obligations Dafny cannot prove alone |
| `src/notify.vibe` | hand-written, tested | One notifier pass → one chat message per person, each retried on its own |

Not modelled: the chat app, HTTP, spreadsheet access, the web dashboard.

## The shell

| In `src/notify.vibe` | Is |
|---|---|
| `messages` | notes grouped into one message per person |
| `Chat` | the chat app as a service: `post(handle, text)`, failing with `Undelivered` |
| `pass` | one notifier pass: sends `notify` to the tracker's `Machine` and posts that pass's `out`, the notes it just recorded, in order; each post is retried on its own (twice, a second apart) while the chat app answers `Undelivered`, and a message it never takes is returned as undelivered while the rest still go out; any other failure ends the pass |

`test/notify.test.vibe` walks the journey through the tracker's `Machine` and
gives `pass` the one fake, a `Chat` that records what is posted to it and
turns some posts away; `TestClock` moves time past the retries.

Delivery is at most once. `pass` records the notes in `sent` before it posts
them, so a message the chat app never takes, or one lost to a crash between
recording and posting, is never sent again.

`gen/*.ts` stays TypeScript; the adapters only wrap it.

## What the checks found

- **A name typed twice was notified twice.** A cell is a list, not a set
  (`ana, ana`), and "Nothing is sent twice" failed in simulation. Fixed: the
  notifier treats a cell as a set of people, and `test/notify.test.vibe` types
  a name twice.
- **A rename left a name in a cell twice.** Fixed: a rename removes duplicate
  names from every owners cell.

Every obligation of the three specs is proved; none rests on simulation alone.
