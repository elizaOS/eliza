# #10470 — `MESSAGE` (sendDraft) outbound-draft extraction: regex → structured LLM extraction

The old `inferSourceFromText` / `inferBodyFromText` / `inferRecipientFromText`
parsed the platform / recipient / body out of the user's text with **English-only
regex** (`/\btelegram\b/`, `/\bto\s+(.+?)\s+saying\b/i`, `/['"]([^'"]{1,1000})['"]/`,
…). Replaced with one `extractOutboundDraftFromText(runtime, text)` that uses the
model's structured output (`useModel(TEXT_LARGE)` → `<response>` XML →
`parseKeyValueXml`). Structured params from the planner/tool-call still win; the
model is only consulted to fill gaps.

## Real-model trajectory (live `gpt-oss-120b` on Cerebras — not a mock)

Exact prompt the action sends. Input → raw model output:

**English** — `send Bob a telegram saying I'm running 10 minutes late`
```
<response>
<source>telegram</source>
<recipient>Bob</recipient>
<body>I'm running 10 minutes late</body>
</response>
```

**Spanish (non-English)** — `envíale a Ana un mensaje de WhatsApp diciendo que llego en 5 minutos`
```
<response>
<source>whatsapp</source>
<recipient>Ana</recipient>
<body>que llego en 5 minutos</body>
</response>
```

**Chinese (non-English)** — `好的，给老王发个微信说今晚的会议取消了`
```
<response>
<source></source>          ← correct: WeChat is not in the supported-platform allow-list
<recipient>老王</recipient>
<body>今晚的会议取消了</body>
</response>
```

## Before/after — the non-English requirement

The old regex matched only English keywords (`telegram`, `to … saying`), so the
**Spanish and Chinese** inputs extracted **nothing** — source/recipient/body all
`undefined`, and the action reported "missing draft details". The model returns
the correct fields in every language. This is the issue's required before/after
for non-English input no longer depending on English keyword matching.

Wiring (fast-path skip when params already structured; `<response>` parse incl.
fence/wrapper tolerance; graceful empty fallback on model error) is covered by
`sendDraft.test.ts` (4 tests). The model's extraction *quality* is this trajectory,
not the stubs.
