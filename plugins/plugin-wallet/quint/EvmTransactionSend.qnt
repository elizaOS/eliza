// chains/evm/actions/helpers.ts sendEvmTransaction, its callers in
// chains/evm/actions/transfer.ts, chains/evm/actions/swap.ts and
// chains/registry.ts executeEvmTransfer, and chains/wallet-action.ts
// resultText. One confirmed spend, its RPC answer, and a later retry that is
// allowed only after a reported failure.
module EvmTransactionSend {
  type State = {
    phase: str, signed: bool, hashKnown: bool, sends: int, landed: int,
    sendUncertain: bool, response: str, retries: int
  }
  var s: State
  action init = s' = {
    phase: "prepare", signed: false, hashKnown: false, sends: 0, landed: 0,
    sendUncertain: false, response: "none", retries: 0
  }
  // Sign locally: the transaction hash is fixed before any send.
  action Sign = all {
    s.phase == "prepare",
    s' = { ...s, phase: "send", signed: true, hashKnown: true }
  }
  // "answered": the node returned the hash.
  // "refused": the node answered with a JSON-RPC refusal; nothing landed.
  // "lostAfterAccept": the node took the transaction, the answer was lost
  //   (timeout, network error, gateway 5xx).
  // "lostBeforeAccept": the request never reached the node; same client view.
  // "alreadyKnown": a gateway sent the transaction twice and returns the
  //   node's "already known" / "nonce too low" answer to the second copy.
  action Send = {
    nondet outcome = Set("answered", "refused", "lostAfterAccept", "lostBeforeAccept", "alreadyKnown").oneOf()
    all {
      s.phase == "send", s.signed,
      if (outcome == "refused")
        s' = { ...s, phase: "done", sends: s.sends + 1, response: "failure" }
      else if (outcome == "answered")
        s' = { ...s, phase: "done", sends: s.sends + 1, landed: s.landed + 1, response: "submitted" }
      else if (outcome == "lostBeforeAccept")
        s' = { ...s, phase: "done", sends: s.sends + 1, sendUncertain: true, response: "uncertain" }
      else
        s' = { ...s, phase: "done", sends: s.sends + 1, landed: s.landed + 1, sendUncertain: true, response: "uncertain" }
    }
  }
  // The user or agent signs a new transaction (next nonce) only after a
  // reported failure. "uncertain" text says not to retry.
  action Retry = all {
    s.phase == "done", s.response == "failure", s.retries < 2,
    s' = { ...s, phase: "prepare", signed: false, hashKnown: false, sendUncertain: false, response: "none", retries: s.retries + 1 }
  }
  action step = any { Sign, Send, Retry, s' = s }
  val SignedBeforeSend = (s.phase == "done").implies(s.signed and s.hashKnown)
  val NoDoublePay = s.landed <= 1
  val FailureOnlyWhenNothingLanded = (s.response == "failure").implies(s.landed == 0)
  val UncertainKeepsHash = (s.response == "uncertain").implies(s.hashKnown and s.sendUncertain)
  val SubmittedLanded = (s.response == "submitted").implies(s.landed == 1)
}
