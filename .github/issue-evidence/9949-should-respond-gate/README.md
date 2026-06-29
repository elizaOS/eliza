# Evidence — #9949 role-keyed should-respond injection/social-engineering gate

Branch: `fix/9946-9961-sec-roles-tui-cloud-embed` · Host: Linux x86_64

## What shipped
The issue: three uncoordinated detectors, none gating the should-respond
decision, no LLM adjudication, no role-keying, zero adversarial tests.

- **Deterministic risk extractor** (`security/should-respond-risk.ts`,
  `extractShouldRespondRisk`): pure, no-I/O scorer that **reuses**
  `SecurityModule`'s existing `INJECTION_PATTERNS` + obfuscation primitives
  (`normalizeForScan` / `reverseString` / `containsObfuscatedKeyword` /
  `getKeywordPattern`) — **no fourth pattern set**. Those primitives were lifted
  to exported module scope (logic unchanged) so both the class and the gate share
  one definition. Emits a typed `RiskFactors`.
- **Role-keyed policy** (`shouldVerifyInjection`): OWNER/ADMIN trusted (escalate
  only on extreme score); USER/GUEST escalate at the borderline band.
- **Single TEXT_LARGE adjudication** (`adjudicateInjectionRisk`): one model call,
  only for borderline+ USER/GUEST messages; **fails OPEN** on any error so the
  message pipeline is never broken.
- **Hook + gate wiring**: a `parallel_with_should_respond` core hook (registered
  next to the incoming-message-security hook) stamps `injectionRisk` +
  `shouldVerifyInjection` onto the message; the gate runs **only when
  `shouldRespond===true`** and, on an injection verdict, routes into the existing
  IGNORE terminal path. Gated by `ELIZA_SHOULD_RESPOND_INJECTION_GATE` (default
  on). Trusted senders / low-risk traffic incur **zero** extra inference.

## Tests — `should-respond-risk.test.ts`: 28 passed
Adversarial coverage:
- benign → score 0, not borderline, no verify
- plain + multilingual + base64 injection patterns → high score
- obfuscation: letter-split (`i g n o r e`, `j-a-i-l-b-r-e-a-k`), reversed words,
  zero-width / hidden chars → detected via the reused primitives
- role-keying: same borderline message → verify for USER/GUEST, not for
  OWNER/ADMIN
- adjudication YES/NO/JSON verdicts; **fail-open on throw and on empty/ambiguous
  response**
- hook stamping (USER vs agent-self vs benign); `readStampedInjectionRisk`
  null/malformed handling

## Notes
- Adds exactly one `TEXT_LARGE` call, and only when `shouldVerifyInjection` is
  true. No new import cycles (verified should-respond-risk imports nothing back
  into message.ts/runtime.ts as values).
