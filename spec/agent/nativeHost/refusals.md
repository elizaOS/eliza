# Safe native host refusals

The native host decides which facts of a failure reach the renderer and
which text may reach the model. Task input and view shapes are in the
[task codecs](../tasks/http.md); normalized text, fingerprint keys and
secret spans stay private to the services that hold them.

## Story: Keep private task failures out of the renderer

> As a user, when a task fails I see a safe error code, never the private
> details behind it.

### A recognized failure projects only its exact machine code

A task error carries a nonempty code and the shared error brand. A
branded error crosses as its code alone, never its message, stack, cause
or a caller's status, and is not cached; any other exception becomes 503
`TASK_UNAVAILABLE`. The owner-record path passes on a code beginning
`TASK_` and hands a native host error to its outer handler.
`TASK_NOT_FOUND`, `TASK_INVALID` and `TASK_ACTION_DENIED` map to 404, 400
and 403; `TASK_CLEANUP_UNCONFIRMED` and every code beginning
`TASK_STORAGE` (case-sensitive) map to 503; other codes map to 409. Codes
are compared by their exact UTF-16 units.

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
pure val hostError: CodedTaskError = { code: "HOST_GOAL_NO_PAGE", codeUnits: List(72, 79, 83, 84, 95, 71, 79, 65, 76, 95, 78, 79, 95, 80, 65, 71, 69), hasCodeString: true, elizaBranded: true, nativeHost: true }
pure val errorValues = Set(hostError, { ...hostError, elizaBranded: false, nativeHost: false }, { ...hostError, code: "TASK_NOT_FOUND", codeUnits: notFoundCode, nativeHost: false, elizaBranded: false }, { ...hostError, code: "TASK_STORAGE", codeUnits: storagePrefix }, { ...hostError, code: "TASK_STORAGE_CORRUPT", codeUnits: storagePrefix.append(95).append(67).append(79).append(82).append(82).append(85).append(80).append(84) }, { ...hostError, code: "", codeUnits: List(), hasCodeString: false })
```

## Story: Keep recognized secrets out of model-facing text

> As a user, a secret I typed or that a page showed is never sent to the
> model as text.

### The outcome preserves the typed scope of refusal and capacity handling

Text that is not a string is refused as 400 `INVALID_TEXT`. Text is
normalized and checked for written and spoken credential forms, which a
consumer may extend with its own terms. The stateless gate refuses a
present match as 422 `SENSITIVE_TEXT`. The stateful gate also remembers
detected values by keyed fingerprint and refuses later text carrying one,
even without a naming word; when its memory is full it refuses as 422
`SENSITIVE_TEXT_CAPACITY`, or, configured to forget, clears its memory and
still refuses the matched text. Display and diagnostics replace matches
with `[removed]`.

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
pure def forgetfulTextGate(facts: TextFacts): TextGate = textGate({ ...facts, capacityRefused: false })
pure def lawKnownSensitiveInputIsRefused(facts: TextFacts): bool = facts.currentMatch or facts.rememberedMatch implies textGate(facts) != TextAdmitted
pure def lawExhaustedScrubberDoesNotAllowInput(facts: TextFacts): bool = facts.capacityRefused implies textGate(facts) != TextAdmitted
pure def lawForgetfulMatchedTextKeepsFixedRefusal(facts: TextFacts): bool = facts.stringInput and facts.currentMatch implies textRefusal(forgetfulTextGate(facts)) == { statusCode: 422, errorCode: "SENSITIVE_TEXT" }
pure def lawStatelessGateUsesOnlyPresentMatch(facts: TextFacts): bool = facts.stringInput and not(facts.currentMatch) implies statelessTextGate(facts) == TextAdmitted
pure val cleanText: TextFacts = { stringInput: true, currentMatch: false, rememberedMatch: false, capacityRefused: false }
pure val factsValues = Set(cleanText, { ...cleanText, stringInput: false }, { ...cleanText, currentMatch: true }, { ...cleanText, rememberedMatch: true }, { ...cleanText, capacityRefused: true }, { ...cleanText, currentMatch: true, capacityRefused: true })
```
