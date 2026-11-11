// chains/registry.ts executeSolanaTransfer/sendAndConfirmSolanaTransaction and
// chains/wallet-action.ts resultText. One signed transaction and its RPC result.
module SolanaTransactionReceipt {
  type State = {
    phase: str, signed: bool, signatureRetained: bool, sends: int,
    sendUncertain: bool, confirmation: str, chain: str, response: str
  }
  var s: State
  action init = s' = {
    phase: "prepare", signed: false, signatureRetained: false, sends: 0,
    sendUncertain: false, confirmation: "none", chain: "unknown", response: "none"
  }
  action Sign = all {
    s.phase == "prepare",
    s' = { ...s, phase: "send", signed: true, signatureRetained: true }
  }
  action Send = {
    nondet outcome = Set("accepted", "rejected", "lost").oneOf()
    all {
      s.phase == "send", s.signed,
      if (outcome == "rejected") s' = { ...s, phase: "failed", sends: 1, chain: "failed", response: "failure" }
      else if (outcome == "lost") s' = { ...s, phase: "submitted", sends: 1, sendUncertain: true, confirmation: "unconfirmed", response: "uncertain" }
      else s' = { ...s, phase: "confirm", sends: 1 }
    }
  }
  action Confirm = {
    nondet outcome = Set("confirmed", "chain-error", "lost").oneOf()
    all {
      s.phase == "confirm",
      if (outcome == "chain-error") s' = { ...s, phase: "failed", chain: "failed", response: "failure" }
      else if (outcome == "lost") s' = { ...s, phase: "submitted", confirmation: "unconfirmed", response: "uncertain" }
      else s' = { ...s, phase: "submitted", chain: "confirmed", confirmation: "confirmed", response: "submitted" }
    }
  }
  action step = any { Sign, Send, Confirm, s' = s }
  val SignedBeforeSend = (s.sends > 0).implies(s.signed and s.signatureRetained)
  val UncertaintyPreservesReceipt = (s.response == "uncertain").implies(s.signatureRetained and s.confirmation == "unconfirmed")
  val HonestConfirmation = (s.confirmation == "confirmed").implies(s.chain == "confirmed")
  val NoAutomaticResubmit = s.sends <= 1
  val DefinitiveFailureOnly = (s.response == "failure").implies(s.chain == "failed")
  val SendUncertaintyDistinct = s.sendUncertain.implies(s.response == "uncertain" and s.phase == "submitted")
}
