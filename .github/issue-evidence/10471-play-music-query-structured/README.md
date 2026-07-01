# #10471 — `PLAY_MUSIC_QUERY` structured/context routing (remove English keyword bank)

## Smell removed (before → after)

`plugins/plugin-music/src/actions/playMusicQuery.ts` — `validatePlayMusicQuery`

**Before:** the op was selected by matching raw `message.content.text.toLowerCase()`
against a ~90-entry **English** `researchKeywords` bank (`"workout"`, `"80s"`,
`"chill"`, `"songs about"`, `"soundtrack"`, …) plus two English `simplePatterns`
regexes (`/play\s+(some\s+)?(jazz|rock|pop|…)/i`). A non-English music request
(`"pon algo de música para entrenar"`, `"最新の曲を再生して"`) matched nothing, so
`validatePlayMusicQuery` returned `false` and the umbrella op-resolver
(`inferMusicLibraryOp`) fell through — misrouting or dropping the request.

**After:** `play_query` is selected from **structured params** (`query` /
`searchQuery` / `song` / `artist` / `album` / `genre` / `mood` / `keywords`) **or**
the turn's **active routing context** (`media` / `knowledge`, via the shared
`getActiveRoutingContextsForTurn`) — the same idiom already used by the sibling
`validateSearchYouTube` / `validateDownloadMusic`. Intent (research vs. direct
search) is decided by the handler's existing LLM analysis (`analyzeMusicQuery`),
never re-derived from English keywords.

Kept (deliberate, per the issue's fast-path allow-list):
- `message.content.source === "discord"` — structural connector gate, not language.
- YouTube-URL deferral — a **machine token** (URL host) check that hands direct
  URLs to the faster `playYouTubeAudio` path; now also inspects a structured query.

Caller updated: `plugins/plugin-music/src/actions/musicLibrary.ts` —
`inferMusicLibraryOp` now passes the structured `options` through to
`validatePlayMusicQuery`.

## Tests

New focused suite `plugins/plugin-music/src/actions/playMusicQuery.test.ts` proves:
- English request in `media` context → validates (parity).
- **Spanish + Japanese requests in `media` context → validate identically** (the
  i18n fix; the old English bank returned `false` here).
- Structured `query` / `genre` → validates regardless of message language.
- No structured query and no music context → does **not** validate.
- Direct YouTube URL (in text or structured query) → defers (`false`).
- Non-discord source → `false`.

```
$ bun run --cwd plugins/plugin-music test -- playMusicQuery
 Test Files  1 passed (1)
      Tests  6 passed (6)

$ bun run --cwd plugins/plugin-music test
 Test Files  14 passed (14)
      Tests  89 passed (89)
```

## Evidence gaps / N/A

- **Live-model trajectory:** N/A in this environment — no supported model key is
  present (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
  `GROQ_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_API_ENDPOINT` all
  unset). The converted decision path is deterministic (structured params +
  routing context) and covered by the real provider unit path above; the
  handler's LLM query analysis is unchanged by this slice.
- **Screenshots / video / audio:** N/A — backend action-contract change only; no
  `packages/app` UI or rendered view code touched.
