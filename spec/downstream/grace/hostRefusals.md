# Safe native host refusals

Grace uses Eliza's `packages/host/native-host/errors.mjs` and
`sensitive-text.mjs` directly. This specification describes their boundary
decisions. The JavaScript error brand, credential matcher, fingerprint
function and normalized text remain private to their owning services.

## Story: Keep private host failures out of the renderer

### Only recognized task errors retain their code across the bridge

A TaskHostError requires a nonempty string code and shares the core
ElizaError brand across separately built task runtimes. The pinned
`interactive-task-http.ts` returns an error code without an arbitrary
exception message. Not found is 404, invalid is 400 and action denied
is 403. Task storage codes and cleanup-unconfirmed are 503. Other
branded codes are 409. An unbranded exception is generic task
unavailability with status 503.

```quint
type ErrorFamily = HostNotFound | HostInvalid | HostActionDenied | HostStorage | HostCleanup | HostConflict
type ErrorReply = { statusCode: int, errorCode: str }
pure def hostStatus(family: ErrorFamily): int =
  if (family == HostNotFound) 404
  else if (family == HostInvalid) 400
  else if (family == HostActionDenied) 403
  else if (family == HostStorage or family == HostCleanup) 503
  else 409
pure def taskRefusal(branded: bool, family: ErrorFamily, errorCode: str): ErrorReply =
  if (branded) { statusCode: hostStatus(family), errorCode: errorCode }
  else { statusCode: 503, errorCode: "TASK_UNAVAILABLE" }
pure def lawPrivateExceptionBecomesGeneric(family: ErrorFamily, errorCode: str): bool =
  taskRefusal(false, family, errorCode) == { statusCode: 503, errorCode: "TASK_UNAVAILABLE" }
pure def lawBrandedTaskErrorPreservesCode(family: ErrorFamily, errorCode: str): bool =
  taskRefusal(true, family, errorCode).errorCode == errorCode
```

## Story: Keep recognized secrets out of model-facing text

### A text gate refuses the entire input and retains only private match evidence

The pinned gate checks string type, normalizes and examines written and
spoken forms, and accepts product matchers including Grace's locale
extensions. A match is a conservative boundary classification. It
does not claim to recognize every secret. A detected input is remembered
by private fingerprints. Later text can be refused because it contains
an already remembered value. Refusal messages carry no matched content.
When the bounded scrubber in refuse mode has exhausted its memory,
a capacity error must propagate. The wider display/log scrubbing path
replaces matched text rather than sending it unchanged.

```quint
type TextFacts = { stringInput: bool, currentMatch: bool, rememberedMatch: bool, memoryExhausted: bool, rememberWorked: bool }
type TextGate = TextAdmitted | InvalidTextInput | SensitiveTextDenied | SensitiveCapacityDenied
pure def textGate(facts: TextFacts): TextGate =
  if (not(facts.stringInput)) InvalidTextInput
  else if (facts.memoryExhausted or (facts.currentMatch and not(facts.rememberWorked))) SensitiveCapacityDenied
  else if (facts.currentMatch or facts.rememberedMatch) SensitiveTextDenied
  else TextAdmitted
pure def lawKnownSensitiveInputIsRefused(facts: TextFacts): bool =
  facts.currentMatch or facts.rememberedMatch implies textGate(facts) != TextAdmitted
pure def lawExhaustedScrubberDoesNotAllowInput(facts: TextFacts): bool =
  facts.memoryExhausted implies textGate(facts) != TextAdmitted
pure val cleanText: TextFacts = { stringInput: true, currentMatch: false, rememberedMatch: false, memoryExhausted: false, rememberWorked: true }
pure val factsValues = Set(cleanText, { ...cleanText, stringInput: false }, { ...cleanText, currentMatch: true },
  { ...cleanText, rememberedMatch: true }, { ...cleanText, memoryExhausted: true },
  { ...cleanText, currentMatch: true, rememberWorked: false })
```
