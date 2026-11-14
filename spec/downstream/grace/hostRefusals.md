# Safe native host refusals

Grace uses the pinned Eliza `packages/host/native-host/errors.mjs` and `sensitive-text.mjs`. Task input and view shapes are in the [task codecs](./taskHttp.md). This model specifies which failure facts cross the boundary. The JavaScript brand, normalized text, fingerprint keys and secret spans stay private to their source services.

## Story: Keep private task failures out of the renderer

### A recognized failure projects only its exact machine code

A `TaskHostError` constructor requires a nonempty string code. It sets the same process-wide `ElizaError` brand used by the task bundle. `interactive-task-http.ts` tests that brand and does not rely on a thrown error's `status`. It sends `{code}` with `Cache-Control: no-store`. An ordinary exception, even one with a string code, becomes 503 `TASK_UNAVAILABLE`. The native gateway's owner-record helper instead recognizes a string beginning `TASK_` and delegates `NativeHostError` to its outer handler. A legitimate code outside `TASK_` can cross the core error path if the exception carries the shared brand.

`TASK_NOT_FOUND`, `TASK_INVALID` and `TASK_ACTION_DENIED` map to 404, 400 and 403. `TASK_CLEANUP_UNCONFIRMED` and every prefix match of `TASK_STORAGE` map to 503. Other codes map to 409. The storage check includes the bare prefix and is case-sensitive. The model consumes the exact UTF-16 units of the code. It projects the original code and excludes exception messages, stacks, causes, context and caller-provided statuses. A JavaScript value posing as a brand with an invalid code is outside the typed producer contract.

```quint
type ErrorReply = { statusCode: int, errorCode: str }
type CodedTaskError = { code: str, codeUnits: List[int], hasCodeString: bool, elizaBranded: bool, nativeHost: bool }
type OwnerErrorDisposition = OwnerErrorReply(ErrorReply) | EscalateNativeHostError
pure val escalateOwnerError: OwnerErrorDisposition = EscalateNativeHostError
pure val taskPrefix: List[int] = List(84, 65, 83, 75, 95)
pure val storageSuffix: List[int] = List(83, 84, 79, 82, 65, 71, 69)
pure val storagePrefix: List[int] = List(84, 65, 83, 75, 95, 83, 84, 79, 82, 65, 71, 69)
pure val notFoundCode: List[int] = List(84, 65, 83, 75, 95, 78, 79, 84, 95, 70, 79, 85, 78, 68)
pure val invalidCode: List[int] = List(84, 65, 83, 75, 95, 73, 78, 86, 65, 76, 73, 68)
pure val deniedCode: List[int] = List(84, 65, 83, 75, 95, 65, 67, 84, 73, 79, 78, 95, 68, 69, 78, 73, 69, 68)
pure val cleanupCode: List[int] = List(84, 65, 83, 75, 95, 67, 76, 69, 65, 78, 85, 80, 95, 85, 78, 67, 79, 78, 70, 73, 82, 77, 69, 68)
pure def taskCodePrefix(codeUnits: List[int]): bool =
  List(codeUnits.nthOr(0, -1), codeUnits.nthOr(1, -1), codeUnits.nthOr(2, -1), codeUnits.nthOr(3, -1), codeUnits.nthOr(4, -1)) == taskPrefix
pure def storageCodePrefix(codeUnits: List[int]): bool = taskCodePrefix(codeUnits) and
  List(codeUnits.nthOr(5, -1), codeUnits.nthOr(6, -1), codeUnits.nthOr(7, -1), codeUnits.nthOr(8, -1), codeUnits.nthOr(9, -1), codeUnits.nthOr(10, -1), codeUnits.nthOr(11, -1)) == storageSuffix
pure def hostStatus(codeUnits: List[int]): int =
  if (codeUnits == notFoundCode) 404
  else if (codeUnits == invalidCode) 400
  else if (codeUnits == deniedCode) 403
  else if (storageCodePrefix(codeUnits) or codeUnits == cleanupCode) 503
  else 409
pure val genericTaskFailure: ErrorReply = { statusCode: 503, errorCode: "TASK_UNAVAILABLE" }
pure def taskErrorConstructorAccepts(hasCodeString: bool, codeUnits: List[int]): bool = hasCodeString and codeUnits.length() > 0
pure def taskRefusal(error: CodedTaskError): ErrorReply =
  if (error.elizaBranded and error.hasCodeString) { statusCode: hostStatus(error.codeUnits), errorCode: error.code }
  else genericTaskFailure
pure def ownerRecordRefusal(error: CodedTaskError): OwnerErrorDisposition =
  if (error.nativeHost) EscalateNativeHostError
  else if (error.hasCodeString and taskCodePrefix(error.codeUnits)) OwnerErrorReply({ statusCode: hostStatus(error.codeUnits), errorCode: error.code })
  else OwnerErrorReply({ statusCode: genericTaskFailure.statusCode, errorCode: genericTaskFailure.errorCode })
pure def lawPrivateExceptionBecomesGeneric(error: CodedTaskError): bool = not(error.elizaBranded) implies taskRefusal(error) == genericTaskFailure
pure def lawBrandedTaskErrorPreservesCode(error: CodedTaskError): bool = error.elizaBranded and error.hasCodeString implies taskRefusal(error).errorCode == error.code
pure def lawOwnerRecordEscalatesNativeError(error: CodedTaskError): bool = error.nativeHost implies ownerRecordRefusal(error) == escalateOwnerError
pure def lawExactTypedCodesHaveStableStatus(codeUnits: List[int]): bool =
  (codeUnits == notFoundCode implies hostStatus(codeUnits) == 404) and
  (codeUnits == invalidCode implies hostStatus(codeUnits) == 400) and
  (codeUnits == deniedCode implies hostStatus(codeUnits) == 403) and
  ((codeUnits == cleanupCode or storageCodePrefix(codeUnits)) implies hostStatus(codeUnits) == 503)
pure val codeUnitsValues = Set(notFoundCode, invalidCode, deniedCode, cleanupCode, storagePrefix, List(), List(84))
pure val hostError: CodedTaskError = { code: "HOST_GOAL_NO_PAGE", codeUnits: List(72, 79, 83, 84, 95, 71, 79, 65, 76, 95, 78, 79, 95, 80, 65, 71, 69), hasCodeString: true, elizaBranded: true, nativeHost: true }
pure val errorValues = Set(hostError, { ...hostError, elizaBranded: false, nativeHost: false }, { ...hostError, code: "TASK_NOT_FOUND", codeUnits: notFoundCode, nativeHost: false, elizaBranded: false }, { ...hostError, code: "TASK_STORAGE", codeUnits: storagePrefix }, { ...hostError, code: "TASK_STORAGE_CORRUPT", codeUnits: storagePrefix.append(95).append(67).append(79).append(82).append(82).append(85).append(80).append(84) }, { ...hostError, code: "", codeUnits: List(), hasCodeString: false })
```

## Story: Keep recognized secrets out of model-facing text

### The outcome preserves the typed scope of refusal and capacity handling

The Eliza matcher rejects nonstrings with 400 `INVALID_TEXT`, then normalizes a string to NFKC, removes zero-width characters and recognizes written and spoken credential forms. Grace extends it with English and Spanish financial/identity terms and spoken Spanish digits. The stateless `requireNonSensitiveText` rejects a current match as 422 `SENSITIVE_TEXT`. The stateful gate remembers detected values using keyed in-memory fingerprints and rejects subsequent texts that carry a remembered value even without a naming word. The default scrubber propagates 422 `SENSITIVE_TEXT_CAPACITY` after full-memory refusal. Grace uses `passwordWords: "credential"` and `onFull: "forget"`, so it clears full memory and retries remembering rather than refusing every later message. The current matched submission still receives a refusal. A separate display and diagnostic scrubber replaces matches with `[removed]`. Classification and fingerprint storage are supplied by their owning services.

```quint
type TextFacts = { stringInput: bool, currentMatch: bool, rememberedMatch: bool, capacityRefused: bool }
type TextGate = TextAdmitted | InvalidTextInput | SensitiveTextDenied | SensitiveCapacityDenied
pure def statelessTextGate(facts: TextFacts): TextGate =
  if (not(facts.stringInput)) InvalidTextInput
  else if (facts.currentMatch) SensitiveTextDenied
  else TextAdmitted
pure def textGate(facts: TextFacts): TextGate =
  if (not(facts.stringInput)) InvalidTextInput
  else if (facts.capacityRefused) SensitiveCapacityDenied
  else if (facts.currentMatch or facts.rememberedMatch) SensitiveTextDenied
  else TextAdmitted
pure def textRefusal(decision: TextGate): ErrorReply =
  if (decision == InvalidTextInput) { statusCode: 400, errorCode: "INVALID_TEXT" }
  else if (decision == SensitiveTextDenied) { statusCode: 422, errorCode: "SENSITIVE_TEXT" }
  else if (decision == SensitiveCapacityDenied) { statusCode: 422, errorCode: "SENSITIVE_TEXT_CAPACITY" }
  else { statusCode: 0, errorCode: "" }
pure def graceTextGate(facts: TextFacts): TextGate = textGate({ ...facts, capacityRefused: false })
pure def lawKnownSensitiveInputIsRefused(facts: TextFacts): bool = facts.currentMatch or facts.rememberedMatch implies textGate(facts) != TextAdmitted
pure def lawExhaustedScrubberDoesNotAllowInput(facts: TextFacts): bool = facts.capacityRefused implies textGate(facts) != TextAdmitted
pure def lawGraceMatchedTextKeepsFixedRefusal(facts: TextFacts): bool = facts.stringInput and facts.currentMatch implies textRefusal(graceTextGate(facts)) == { statusCode: 422, errorCode: "SENSITIVE_TEXT" }
pure def lawStatelessGateUsesOnlyPresentMatch(facts: TextFacts): bool = facts.stringInput and not(facts.currentMatch) implies statelessTextGate(facts) == TextAdmitted
pure val cleanText: TextFacts = { stringInput: true, currentMatch: false, rememberedMatch: false, capacityRefused: false }
pure val factsValues = Set(cleanText, { ...cleanText, stringInput: false }, { ...cleanText, currentMatch: true }, { ...cleanText, rememberedMatch: true }, { ...cleanText, capacityRefused: true }, { ...cleanText, currentMatch: true, capacityRefused: true })
```
