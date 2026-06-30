# Evidence — #10471 honesty detectors were English-only (i18n-hostile)

The removed detectors (`refusal-detector.ts`, `cutoff-leak-detector.ts`, `fabricated-moderation-detector.ts`, plus the `stage1-honesty-detector.ts` wrappers) blanked the model's Stage-1 reply on a regex match. The regexes match **English only** — a non-English refusal / cutoff-leak / fabricated-moderation reply slipped through and was served to the user anyway, so the suppression fired inconsistently by language. Removal makes routing purely structural; the **system-prompt honesty rules** (`packages/prompts/src/index.ts:699`/`:701`, language-agnostic instructions to the model) are the real guard.

(Tables below are auto-extracted from the deleted source's regex literals via `git show origin/develop`. `refusal-detector`'s `REFUSAL_OPENERS` is a multi-line array the simple extractor under-reads, so it is described rather than tabled.)

## refusal detector

`REFUSAL_OPENERS` are anchored **English** sentence openers — `^\s*…i (cannot|can't|can not)…`, `i (unable|not able) to…`, `i('m| am) (sorry|afraid)…`, `i (won't|will not)…`. They match the English `"I cannot help with that request."` and miss every non-English equivalent (`"Lo siento, no puedo ayudarte con eso."`, `"申し訳ありませんが、それはお手伝いできません。"`, `"Es tut mir leid, das kann ich nicht tun."`) — the same English-only failure mode the two banks below show concretely.

## cutoff detector — did the English regex match?

| lang | phrase | matched |
|---|---|---|
| en | As of my training data, the latest version was 22. | ✅ blanked |
| es | Según mis datos de entrenamiento, la última versión era 22. | ❌ MISSED → served |
| ja | 私のトレーニングデータでは、最新バージョンは22でした。 | ❌ MISSED → served |

## moderation detector — did the English regex match?

| lang | phrase | matched |
|---|---|---|
| en | Your request violates our content policy. | ✅ blanked |
| es | Tu solicitud viola nuestra política de contenido. | ❌ MISSED → served |
| ja | あなたのリクエストは私たちのコンテンツポリシーに違反しています。 | ❌ MISSED → served |

**Conclusion:** the English (`en`) phrase is caught in every bank; the `es`/`ja`/`de` equivalents are missed. The detector only ever protected English-speaking users, and only as a post-hoc backstop to the system prompt — which still forbids these patterns for all languages.
