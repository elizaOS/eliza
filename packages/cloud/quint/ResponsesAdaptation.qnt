// The stateless Responses -> canonical chat adapter. Single request, three
// supported transcript kinds and two explicit rejection kinds. Provider truth,
// auth correctness, durable accounting and HTTP transport are outside this model.
module ResponsesAdaptation {
  pure val Kinds = Set("text", "media", "tools", "unsupported", "invalid")
  pure val Outcomes = Set("stop", "tools", "refusal", "empty-refusal", "length", "filtered", "malformed", "denied", "failed")
  pure val Transcript = List(" instruction one \n", "before", "media-or-call", "after", " instruction two \n")
  pure val Output = " output with whitespace \n"
  var s: {
    stage: str, kind: str, auth: bool, input: List[str], forwarded: List[str],
    credential: int, forwardedCredential: int, nativeCalls: int, chatCalls: int,
    providerOutcome: str, outputKind: str, output: str, incompleteReason: str, responseIdentity: int
  }
  pure val initial = {
    stage: "received", kind: "text", auth: true, input: Transcript, forwarded: List(),
    credential: 1, forwardedCredential: 0, nativeCalls: 0, chatCalls: 0,
    providerOutcome: "unknown", outputKind: "none", output: "", incompleteReason: "", responseIdentity: 0
  }
  action init = {
    nondet kind = Kinds.oneOf()
    nondet allowed = Set(true, false).oneOf()
    s' = { ...initial, kind: kind, auth: allowed }
  }
  action initAccepted = s' = initial
  action validate = all {
    s.stage == "received",
    s' = { ...s, stage: if (Set("invalid", "unsupported").contains(s.kind)) "rejected" else "validated" }
  }
  action prepare = all {
    s.stage == "validated",
    s' = { ...s, stage: "prepared", forwarded: s.input,
      forwardedCredential: s.credential, nativeCalls: 1 }
  }
  action canonical = all {
    s.stage == "prepared",
    s' = { ...s, stage: if (s.auth) "provider" else "denied", chatCalls: 1 }
  }
  action providerReturns(outcome: str): bool = all {
    s.stage == "provider", Outcomes.contains(outcome),
    s' = { ...s, stage: "mapping", providerOutcome: outcome }
  }
  action mapResponse = all {
    s.stage == "mapping",
    s' = if (Set("malformed", "failed").contains(s.providerOutcome))
      { ...s, stage: "failed" }
    else if (s.providerOutcome == "denied") { ...s, stage: "denied" }
    else { ...s,
      stage: if (Set("length", "filtered", "empty-refusal").contains(s.providerOutcome)) "incomplete" else "completed",
      output: if (s.providerOutcome == "empty-refusal") "" else Output, responseIdentity: 1,
      outputKind: if (s.providerOutcome == "refusal") "refusal" else if (s.providerOutcome == "empty-refusal") "none" else "text",
      incompleteReason: if (Set("length", "empty-refusal").contains(s.providerOutcome)) "max_output_tokens"
        else if (s.providerOutcome == "filtered") "content_filter" else "" }
  }
  action step = any {
    validate, prepare, canonical,
    { nondet outcome = Outcomes.oneOf(); providerReturns(outcome) },
    mapResponse, s' = s
  }
  val terminal = Set("completed", "incomplete", "failed", "denied", "rejected").contains(s.stage)
  val contentPreserved = s.nativeCalls > 0 implies s.forwarded == s.input
  val authorityPreserved = s.nativeCalls > 0 implies s.forwardedCredential == s.credential
  val effectsOnlyForAcceptedInput = (s.nativeCalls > 0 or s.chatCalls > 0) implies
    not(Set("unsupported", "invalid").contains(s.kind))
  val singleCanonicalOwner = s.nativeCalls <= 1 and s.chatCalls <= 1 and s.chatCalls <= s.nativeCalls
  val noFabricatedCompletion = s.stage == "completed" implies Set("stop", "tools", "refusal").contains(s.providerOutcome)
  val incompleteHasCause = s.stage == "incomplete" implies
    ((Set("length", "empty-refusal").contains(s.providerOutcome) and s.incompleteReason == "max_output_tokens") or
     (s.providerOutcome == "filtered" and s.incompleteReason == "content_filter"))
  val outputPreserved = Set("completed", "incomplete").contains(s.stage) implies
    s.output == (if (s.providerOutcome == "empty-refusal") "" else Output) and s.responseIdentity == 1
  val refusalTyped = all {
    s.stage == "completed" and s.providerOutcome == "refusal" implies s.outputKind == "refusal",
    s.stage == "incomplete" and s.providerOutcome == "empty-refusal" implies s.outputKind == "none"
  }
  val deniedNeverDispatches = not(s.auth) implies s.providerOutcome == "unknown"
  val unknownNeverCompletes = s.providerOutcome == "unknown" implies
    not(Set("completed", "incomplete").contains(s.stage))
  val safety = contentPreserved and authorityPreserved and effectsOnlyForAcceptedInput and
    singleCanonicalOwner and refusalTyped and noFabricatedCompletion and incompleteHasCause and outputPreserved and
    deniedNeverDispatches and unknownNeverCompletes
  action providerCompletion = { nondet outcome = Outcomes.oneOf(); providerReturns(outcome) }
  temporal FairSteps = validate.weakFair(s) and prepare.weakFair(s) and canonical.weakFair(s)
    and providerCompletion.weakFair(s) and mapResponse.weakFair(s)
  temporal FairRequestTerminates = FairSteps implies eventually(terminal)
  temporal RequestAlwaysTerminates = eventually(terminal)

  // Historical failures are excluded from step; negative witnesses make these
  // invariants discriminate the original adapter behavior.
  action oldDropContent = all { s.stage == "validated",
    s' = { ...s, stage: "prepared", forwarded: List("instruction one", "before", "after"),
      forwardedCredential: 1, nativeCalls: 1 } }
  action oldFabricateCompletion = all { s.stage == "mapping",
    s' = { ...s, stage: "completed", output: "", responseIdentity: 2 } }
  run mediaAndInstructionsPreservedTest = initAccepted.then(validate).then(prepare).then(canonical)
    .then(providerReturns("stop")).then(mapResponse).expect(safety and s.stage == "completed")
  run limitIsIncompleteTest = initAccepted.then(validate).then(prepare).then(canonical)
    .then(providerReturns("length")).then(mapResponse).expect(safety and s.stage == "incomplete")
  run malformedOutputFailsTest = initAccepted.then(validate).then(prepare).then(canonical)
    .then(providerReturns("malformed")).then(mapResponse).expect(safety and s.stage == "failed")
  run refusalHasOriginalContentTest = initAccepted.then(validate).then(prepare).then(canonical)
    .then(providerReturns("refusal")).then(mapResponse).expect(safety and s.outputKind == "refusal" and s.output == Output)
  run emptyBilledRefusalIsIncompleteTest = initAccepted.then(validate).then(prepare).then(canonical)
    .then(providerReturns("empty-refusal")).then(mapResponse).expect(safety and s.stage == "incomplete" and s.output == "")
  run unknownOutputStaysPendingTest = initAccepted.then(validate).then(prepare).then(canonical)
    .expect(safety and not(terminal))
  run droppedContentDetectedTest = initAccepted.then(validate).then(oldDropContent).expect(not(contentPreserved))
  run oldLimitCompletionDetectedTest = initAccepted.then(validate).then(prepare).then(canonical)
    .then(providerReturns("length")).then(oldFabricateCompletion).expect(not(noFabricatedCompletion))
  run oldEmptySuccessDetectedTest = initAccepted.then(validate).then(prepare).then(canonical)
    .then(providerReturns("malformed")).then(oldFabricateCompletion).expect(not(noFabricatedCompletion) and not(outputPreserved))
}
