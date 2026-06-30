# #10470 — MANAGE_BROWSER_BRIDGE subaction: regex → structured LLM extraction

The action's own header says "the LLM picks the child action" via the `action`
param. The legacy fallback `inferSubactionFromMessage` regex-matched the
subaction from English (+ a bolted-on ~18-language) keyword list. Replaced with
`extractBrowserBridgeSubaction(runtime, text)` — `useModel(TEXT_LARGE)` →
`<response>` XML → `parseKeyValueXml` — only consulted when no explicit
`action`/`subaction` param; defaults to `install` on failure.

## Real-model trajectory (live gpt-oss-120b on Cerebras)
```
"show me the extension build folder"  → <subaction>reveal_folder</subaction>
"vuelve a conectar el companion" (ES)  → <subaction>refresh</subaction>
"打开chrome的扩展管理页面" (ZH)         → <subaction>open_manager</subaction>
```
The old regex only matched English; the model picks the right subaction in any
language. Wiring (explicit-param fast path, parse, default-on-failure) is covered
by the plugin test suite (143 tests pass).
