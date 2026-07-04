# Issue #12360 — Automations UI vocabulary cleanup (residual): triggersview "Heartbeat" → "Trigger"

## What changed

Parent #12177 (PR #12385) renamed the Automations UI vocabulary from
"Heartbeat" to "Trigger", but left a residual: the `triggersview.*` i18n keys
still carried "Heartbeat" wording in their *values*. This PR renames the
user-visible "Heartbeat" wording to "Trigger" across all eight locale files in
`packages/ui/src/i18n/locales/`.

Renamed values only — no key added, removed, or renamed (i18n key parity is
preserved). The following `triggersview.*` keys were updated per locale, using
the term each locale already uses for "Trigger" (from `nav.triggers` /
`automations.newTriggerButton`):

- `createFirstTrigger`, `createTrigger`, `deleteTitle`, `editTrigger`,
  `newTrigger`, `emptyStateDescription`, `searchTriggers`, `selectATrigger`,
  `noMatchingTriggers`, `validationScheduledTimeRequired`, and `eGDailyDigestH`
  (the "Heartbeat Check" example placeholder).

Per-locale "Trigger" term:
- en: Trigger · es: disparador · pt: gatilho · tl/vi: trigger ·
  ja: トリガー · ko: 트리거 · zh-CN: 触发器

`es.eGDailyDigestH` was left as-is: its value ("Health check") already carried
no "Heartbeat" wording, so it was outside the rename scope (11 keys changed per
locale; 10 for es).

### Strictly excluded (glossary reserves "Heartbeat" for connector/session
keep-alive uptime) — untouched:
`heartbeat.*`, `cloud.agents.detail.lastHeartbeatLabel`,
`elizaclouddashboard.NoHeartbeatYet`, and every non-`triggersview.*` key.

## Verification

### 1. Zero `triggersview.*` keys with Heartbeat wording (all locales)

```
$ grep -rn '"triggersview\.' packages/ui/src/i18n/locales/*.json | grep -i heartbeat
$ echo "exit: $?"
exit: 1

# localized heartbeat terms too (ハートビート / 하트비트 / 心跳 / nhịp tim / batimento):
$ grep -rnE '"triggersview\.' packages/ui/src/i18n/locales/*.json \
    | grep -iE 'heartbeat|ハートビート|하트비트|心跳|nhịp tim|batimento' || echo NONE
NONE
```

### 2. JSON still valid

```
$ for f in packages/ui/src/i18n/locales/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f'))" && echo "$f ok"; done
packages/ui/src/i18n/locales/en.json ok
packages/ui/src/i18n/locales/es.json ok
packages/ui/src/i18n/locales/ja.json ok
packages/ui/src/i18n/locales/ko.json ok
packages/ui/src/i18n/locales/pt.json ok
packages/ui/src/i18n/locales/tl.json ok
packages/ui/src/i18n/locales/vi.json ok
packages/ui/src/i18n/locales/zh-CN.json ok
```

### 3. Key parity preserved vs origin/develop (no keys added/removed)

```
$ for f in $(ls packages/ui/src/i18n/locales/*.json); do diff <(node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('$f'))).sort().join('\n'))") <(git show origin/develop:$f | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(Object.keys(JSON.parse(d)).sort().join('\n')))") && echo "$f keys-unchanged"; done
packages/ui/src/i18n/locales/en.json keys-unchanged
packages/ui/src/i18n/locales/es.json keys-unchanged
packages/ui/src/i18n/locales/ja.json keys-unchanged
packages/ui/src/i18n/locales/ko.json keys-unchanged
packages/ui/src/i18n/locales/pt.json keys-unchanged
packages/ui/src/i18n/locales/tl.json keys-unchanged
packages/ui/src/i18n/locales/vi.json keys-unchanged
packages/ui/src/i18n/locales/zh-CN.json keys-unchanged
```

### 4. Excluded keys untouched

```
$ git diff packages/ui/src/i18n/locales/ | grep -iE 'heartbeat\.|lastHeartbeatLabel|NoHeartbeatYet' || echo "NONE TOUCHED"
NONE TOUCHED
```
