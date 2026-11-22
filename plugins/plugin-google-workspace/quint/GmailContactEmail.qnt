// MESSAGE op=send source=gmail with an entity UUID target reaches the Gmail
// send connector (plugins/plugin-google-workspace/src/gmail-message-connector.ts).
// In legacy mode (IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE off, the default),
// resolveLegacyRecipientEmail picks the recipient from what the entity stores:
//   - named emails: the `email` / `emailAddress` field of the entity metadata,
//     where CONTACT create and update store a contact's email
//     (plugins/plugin-assistant/src/actions/contact.ts), and the same fields
//     of the entity's components;
//   - only when no named email exists, email-shaped values under other keys
//     of the components.
// One distinct address is sent to; two distinct named addresses refuse as
// ambiguous; none refuses as unresolved. In claim mode only an active,
// verified Google claim counts, and these cases store no claim.
// One case: a contact saved through CONTACT create with or without an email,
// and optionally another component with an `email` field and an email-shaped
// value, then one send.
module GmailContactEmail {
  // Addresses.
  pure val NoAddress = 0
  pure val Work = 1
  pure val Home = 2
  pure val FrontDesk = 3
  // Refusals.
  pure val NoRefusal = 0
  pure val Unresolved = 1
  pure val Ambiguous = 2
  pure val ClaimMissing = 3
  // Phases of the replay.
  pure val Start = 0
  pure val ContactSaved = 1
  pure val Sent = 2

  // IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE is on.
  var claims: bool
  // The email CONTACT create stored on the entity metadata.
  var contact: int
  // The `email` field of another component.
  var named: int
  // An email-shaped value under another key of that component.
  var shaped: int
  var phase: int
  // The address the send went to, and the refusal.
  var delivered: int
  var refusal: int
  var sends: int

  // Two distinct named addresses.
  pure def conflicting(contactEmail: int, namedEmail: int): bool = and {
    contactEmail != NoAddress,
    namedEmail != NoAddress,
    contactEmail != namedEmail,
  }
  // The address a legacy send goes to.
  pure def legacyRecipient(contactEmail: int, namedEmail: int, shapedEmail: int): int =
    if (conflicting(contactEmail, namedEmail)) NoAddress
    else if (contactEmail != NoAddress) contactEmail
    else if (namedEmail != NoAddress) namedEmail
    else shapedEmail
  pure def recipient(
    claimMode: bool,
    contactEmail: int,
    namedEmail: int,
    shapedEmail: int,
  ): int =
    if (claimMode) NoAddress
    else legacyRecipient(contactEmail, namedEmail, shapedEmail)
  pure def refusalOf(
    claimMode: bool,
    contactEmail: int,
    namedEmail: int,
    shapedEmail: int,
  ): int =
    if (claimMode) ClaimMissing
    else if (conflicting(contactEmail, namedEmail)) Ambiguous
    else if (legacyRecipient(contactEmail, namedEmail, shapedEmail) == NoAddress)
      Unresolved
    else NoRefusal

  action init = {
    nondet claimMode = Set(false, true).oneOf()
    nondet contactEmail = Set(NoAddress, Work, Home).oneOf()
    nondet namedEmail = Set(NoAddress, Work, Home).oneOf()
    nondet shapedEmail = Set(NoAddress, FrontDesk).oneOf()
    all {
      claims' = claimMode,
      contact' = contactEmail,
      named' = namedEmail,
      shaped' = shapedEmail,
      phase' = Start,
      delivered' = NoAddress,
      refusal' = NoRefusal,
      sends' = 0,
    }
  }
  // The next replay step runs: the contact and its component are saved, then
  // MESSAGE sends to the contact.
  action advance = all {
    phase != Sent,
    claims' = claims,
    contact' = contact,
    named' = named,
    shaped' = shaped,
    phase' = phase + 1,
    delivered' =
      if (phase == ContactSaved) recipient(claims, contact, named, shaped)
      else delivered,
    refusal' =
      if (phase == ContactSaved) refusalOf(claims, contact, named, shaped)
      else refusal,
    sends' =
      if (phase == ContactSaved and recipient(claims, contact, named, shaped) != NoAddress)
        sends + 1
      else sends,
  }
  // The next step has not run yet.
  action stutter = all {
    claims' = claims,
    contact' = contact,
    named' = named,
    shaped' = shaped,
    phase' = phase,
    delivered' = delivered,
    refusal' = refusal,
    sends' = sends,
  }
  action step = any { advance, stutter }

  val ModelState = {
    claims: claims,
    contact: contact,
    named: named,
    shaped: shaped,
    phase: phase,
    delivered: delivered,
    refusal: refusal,
    sends: sends,
  }
  val Finished = phase == Sent
  temporal ReplayEndsWithoutFairness = eventually(Finished)
  temporal ReplayEnds = advance.weakFair(ModelState)
    .implies(ReplayEndsWithoutFairness)

  // In legacy mode, a contact saved with an email is sent to that email
  // unless another component names a different one.
  val ContactEmailDelivers =
    phase != Sent or claims or contact == NoAddress or
      conflicting(contact, named) or delivered == contact
  // Two distinct named emails refuse instead of picking one.
  val DistinctNamedEmailsRefuse =
    phase != Sent or claims or not(conflicting(contact, named)) or
      (delivered == NoAddress and refusal == Ambiguous)
  // An email-shaped value is used only when no named email exists.
  val NamedEmailBeatsShaped =
    phase != Sent or (contact == NoAddress and named == NoAddress) or
      delivered != FrontDesk
  // Without any stored email the send refuses as unresolved.
  val NoStoredEmailRefuses =
    phase != Sent or claims or contact != NoAddress or named != NoAddress or
      shaped != NoAddress or refusal == Unresolved
  // Claim mode never sends to a stored email without a verified claim.
  val ClaimModeIgnoresStoredEmail =
    phase != Sent or not(claims) or
      (delivered == NoAddress and refusal == ClaimMissing)
  val TypeOK = and {
    Set(NoAddress, Work, Home).contains(contact),
    Set(NoAddress, Work, Home).contains(named),
    Set(NoAddress, FrontDesk).contains(shaped),
    Set(NoAddress, Work, Home, FrontDesk).contains(delivered),
    Set(NoRefusal, Unresolved, Ambiguous, ClaimMissing).contains(refusal),
    phase.in(Start.to(Sent)),
    sends.in(0.to(1)),
    (sends == 1) == (delivered != NoAddress),
    phase == Sent or (delivered == NoAddress and refusal == NoRefusal),
    phase != Sent or ((delivered != NoAddress) != (refusal != NoRefusal)),
  }
}
