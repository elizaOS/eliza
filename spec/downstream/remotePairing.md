# AlphaPhone remote agent pairing

AlphaPhone imports `packages/contracts/src/contracts/remote-agent-pairing.ts`
from Eliza `c518127a025ab173874af9c7d304f26b25213b0d`. Pairing under the app
host is handled by `packages/app/src/api/auth-pairing-routes.ts`; the
agent-only server has a separate handler in
`packages/agent/src/api/auth-routes.ts`. The app host intercepts first
and issues a revocable machine session. The agent-only handler returns
a configured connection credential for routes that accept it. A consumer
must establish which host it is contacting.

## Story: Pair the phone with the exact selected agent instance

### A link provides reviewed pairing inputs and requires an origin trust decision

The link is at most 2,048 UTF-16 units and has the selected scheme,
host `remote`, and path `/agent-pair`. It carries one each of version,
origin, code, and instance, with no extra fields. Authority credentials,
ports on the outer link, and a fragment are rejected. The embedded URL
must normalize to a credential-free HTTPS origin without a path, query,
or fragment. The accepted code is trimmed, uppercased and checked
against the producer's alphabet and group count. The UUID normalizes
to lowercase. HTTPS parsing and identifier shape are decoder evidence.
Before pairing, a consumer must trust the resulting origin and compare
the server's public status with the selected instance.

```quint
pure def pairLinkValid(uriLength: int, routeExact: bool, authorityClean: bool, fieldsExact: bool, versionOne: bool, httpsOrigin: bool, codeValid: bool, instanceValid: bool): bool =
  uriLength > 0 and uriLength <= 2048 and routeExact and authorityClean and fieldsExact and versionOne and httpsOrigin and codeValid and instanceValid
pure def requestPairing(linkValid: bool, trustedOrigin: bool, sameInstance: bool): bool =
  linkValid and trustedOrigin and sameInstance
pure def lawPairingNeedsTrust(linkValid: bool, trustedOrigin: bool, sameInstance: bool): bool =
  requestPairing(linkValid, trustedOrigin, sameInstance) implies trustedOrigin and sameInstance
pure def lawPairLinkCannotCarryExtraField(uriLength: int, routeExact: bool, authorityClean: bool, versionOne: bool, httpsOrigin: bool, codeValid: bool, instanceValid: bool): bool =
  not(pairLinkValid(uriLength, routeExact, authorityClean, false, versionOne, httpsOrigin, codeValid, instanceValid))
```

### The app host consumes a code only after admitting session minting

Public status reveals readiness and issuing instance. Reading the owner
code requires a trusted operator and pairingEnabled nonmanaged deployment.
Pairing requires the exact current instance and a known peer address.
An expired code reports 410. Invalid attempts consume rate limit budget.
Owner and guest codes authorize distinct identities. A missing session
store returns a retryable 503 and preserves an otherwise valid code.
After readiness, the host consumes the code before awaiting identity
and session creation. Failed minting reports 500 and cannot restore the
consumed code. A successful result represents a session ID and owner or
guest access. Network delivery and DB lifetime are external. This machine
projects one issued code and one request racing an attempt to reuse it.

```quint
type PairAccess = PairedOwner | PairedGuest
type PairPhase = UnissuedCode | AvailableCode | MintingSession | SessionIssued | SessionIssueFailed
type PairReply = NoPairReply | RetryPairing | MismatchedPairing | ExpiredPairing | InvalidPairing | ThrottledPairing | PairingDisabled | IssuedPairing | FailedPairing
type Pairing = { phase: PairPhase, role: PairAccess, serial: int, sessionId: int, reply: PairReply }
pure val initial: Pairing = { phase: UnissuedCode, role: PairedOwner, serial: 0, sessionId: 0, reply: NoPairReply }
pure def canIssueCode(p: Pairing, operator: bool, pairingEnabled: bool): bool = p.phase == UnissuedCode and operator and pairingEnabled
pure def issueCode(p: Pairing, operator: bool, pairingEnabled: bool, access: PairAccess): Pairing =
  { ...p, phase: AvailableCode, role: access, serial: p.serial + 1 }
pure def canRedeemCode(p: Pairing): bool = p.phase != MintingSession
pure def redeemCode(p: Pairing, pairingEnabled: bool, peerKnown: bool, instanceExact: bool, tokenExact: bool, codeExpired: bool, hasBudget: bool, storeReady: bool): Pairing =
  if (not(pairingEnabled)) { ...p, reply: PairingDisabled }
  else if (not(peerKnown)) { ...p, reply: InvalidPairing }
  else if (not(instanceExact)) { ...p, reply: MismatchedPairing }
  else if (p.phase == AvailableCode and tokenExact and codeExpired) { ...p, phase: UnissuedCode, reply: ExpiredPairing }
  else if (p.phase != AvailableCode or not(tokenExact)) { ...p, reply: if (hasBudget) InvalidPairing else ThrottledPairing }
  else if (not(storeReady)) { ...p, reply: RetryPairing }
  else { ...p, phase: MintingSession, reply: NoPairReply }
pure def canFinishMint(p: Pairing): bool = p.phase == MintingSession
pure def finishMint(p: Pairing, saved: bool): Pairing =
  if (saved) { ...p, phase: SessionIssued, sessionId: p.serial, reply: IssuedPairing }
  else { ...p, phase: SessionIssueFailed, reply: FailedPairing }
pure def alwaysPairingCoordinates(p: Pairing): bool =
  p.serial >= 0 and p.sessionId >= 0 and p.sessionId <= p.serial and
  (((p.phase == SessionIssued) == (p.sessionId > 0))) and (p.phase != UnissuedCode implies p.serial > 0)
pure def alwaysTransientPairReplyKeepsCode(p: Pairing): bool = p.reply == RetryPairing implies p.phase == AvailableCode
pure def stepFinishedMintCannotBeRepeated(before: Pairing, via: str, after: Pairing): bool =
  ((before.phase == SessionIssued or before.phase == SessionIssueFailed) and via == "redeemCode") implies
    after.phase == before.phase and after.sessionId == before.sessionId
pure def sometimesPairingRetries(p: Pairing): bool = p.reply == RetryPairing
pure def sometimesGuestPaired(p: Pairing): bool = p.phase == SessionIssued and p.role == PairedGuest
pure def sometimesCodeConsumedWithoutSession(p: Pairing): bool = p.phase == SessionIssueFailed
```
