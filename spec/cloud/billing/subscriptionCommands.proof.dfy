lemma confirm_ensures(c: Command, by_: core__sessions_SessionOwner, sub: cloud__billing__subscriptions_Subscription, kind: cloud__billing__subscriptions_CommandKind, commandId: string, quoteId: string, expectedRevision: int, attachmentProviderId: string, digest: string, freshOwner: bool)
  ensures (inv(c) ==> canConfirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner) ==> alwaysQuoteIsTheReviewedEstimate(confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).state))
  ensures (inv(c) ==> canConfirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner) ==> alwaysCommandIsWellFormed(confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).state))
  ensures (inv(c) ==> canConfirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner) ==> alwaysConfigurationWaitsForItsSchedule(confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).state))
  ensures (inv(c) ==> canConfirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner) ==> alwaysVerifiedAttachmentKeepsItsOrigin(confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).state))
  ensures (inv(c) ==> canConfirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner) ==> alwaysReceiptIsSound(confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).state))
  ensures (inv(c) ==> canConfirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner) ==> alwaysOutcomeFollowsTheReceipt(confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).state))
  ensures (inv(c) ==> canConfirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner) ==> stepStartedCommandIsFixed(c, confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).state))
  ensures (inv(c) ==> canConfirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner) ==> stepReceiptKeepsItsRules(c, "confirm", confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).state))
  ensures (inv(c) ==> canConfirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner) ==> stepSlotFollowsTheCommand(c, confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).state, confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).out))
  ensures (inv(c) ==> canConfirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner) ==> stepAllowanceAdjustedOnceByAPaidUpgrade(c, confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).state, confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).out))
  ensures (inv(c) ==> canConfirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner) ==> stepDowngradeScheduledOnApply(c, confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).state, confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner).out))
{
  if inv(c) && canConfirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner) {
    var done := confirm(c, by_, sub, kind, commandId, quoteId, expectedRevision, attachmentProviderId, digest, freshOwner);
    var claimed := ClaimSlot(kind, commandId, expectedRevision);
    assert !holdsSlot(c) && holdsSlot(done.state);
    assert done.out == [claimed];
    assert isSlotClaim(claimed) && !isSlotRelease(claimed);
    assert namesCommand(done.state, claimed);
    assert claimed in done.out;
    assert forall e :: e in done.out ==> e == claimed;
    assert stepSlotFollowsTheCommand(c, done.state, done.out);
  }
}

lemma expireConfiguration_ensures(c: Command)
  ensures (inv(c) ==> canExpireConfiguration(c) ==> alwaysQuoteIsTheReviewedEstimate(expireConfiguration(c).state))
  ensures (inv(c) ==> canExpireConfiguration(c) ==> alwaysCommandIsWellFormed(expireConfiguration(c).state))
  ensures (inv(c) ==> canExpireConfiguration(c) ==> alwaysConfigurationWaitsForItsSchedule(expireConfiguration(c).state))
  ensures (inv(c) ==> canExpireConfiguration(c) ==> alwaysVerifiedAttachmentKeepsItsOrigin(expireConfiguration(c).state))
  ensures (inv(c) ==> canExpireConfiguration(c) ==> alwaysReceiptIsSound(expireConfiguration(c).state))
  ensures (inv(c) ==> canExpireConfiguration(c) ==> alwaysOutcomeFollowsTheReceipt(expireConfiguration(c).state))
  ensures (inv(c) ==> canExpireConfiguration(c) ==> stepStartedCommandIsFixed(c, expireConfiguration(c).state))
  ensures (inv(c) ==> canExpireConfiguration(c) ==> stepReceiptKeepsItsRules(c, "expireConfiguration", expireConfiguration(c).state))
  ensures (inv(c) ==> canExpireConfiguration(c) ==> stepSlotFollowsTheCommand(c, expireConfiguration(c).state, expireConfiguration(c).out))
  ensures (inv(c) ==> canExpireConfiguration(c) ==> stepAllowanceAdjustedOnceByAPaidUpgrade(c, expireConfiguration(c).state, expireConfiguration(c).out))
  ensures (inv(c) ==> canExpireConfiguration(c) ==> stepDowngradeScheduledOnApply(c, expireConfiguration(c).state, expireConfiguration(c).out))
{
  if inv(c) && canExpireConfiguration(c) {
    var done := expireConfiguration(c);
    var released := ReleaseSlot(c.commandId);
    assert holdsSlot(c) && !holdsSlot(done.state);
    assert done.out == [released];
    assert isSlotRelease(released) && !isSlotClaim(released);
    assert namesCommand(done.state, released);
    assert released in done.out;
    assert forall e :: e in done.out ==> e == released;
    assert stepSlotFollowsTheCommand(c, done.state, done.out);
  }
}

lemma finish_ensures(c: Command, invoice: UpgradeInvoice, resultRevision: int)
  ensures (inv(c) ==> canFinish(c, invoice, resultRevision) ==> alwaysQuoteIsTheReviewedEstimate(finish(c, invoice, resultRevision).state))
  ensures (inv(c) ==> canFinish(c, invoice, resultRevision) ==> alwaysCommandIsWellFormed(finish(c, invoice, resultRevision).state))
  ensures (inv(c) ==> canFinish(c, invoice, resultRevision) ==> alwaysConfigurationWaitsForItsSchedule(finish(c, invoice, resultRevision).state))
  ensures (inv(c) ==> canFinish(c, invoice, resultRevision) ==> alwaysVerifiedAttachmentKeepsItsOrigin(finish(c, invoice, resultRevision).state))
  ensures (inv(c) ==> canFinish(c, invoice, resultRevision) ==> alwaysReceiptIsSound(finish(c, invoice, resultRevision).state))
  ensures (inv(c) ==> canFinish(c, invoice, resultRevision) ==> alwaysOutcomeFollowsTheReceipt(finish(c, invoice, resultRevision).state))
  ensures (inv(c) ==> canFinish(c, invoice, resultRevision) ==> stepStartedCommandIsFixed(c, finish(c, invoice, resultRevision).state))
  ensures (inv(c) ==> canFinish(c, invoice, resultRevision) ==> stepReceiptKeepsItsRules(c, "finish", finish(c, invoice, resultRevision).state))
  ensures (inv(c) ==> canFinish(c, invoice, resultRevision) ==> stepSlotFollowsTheCommand(c, finish(c, invoice, resultRevision).state, finish(c, invoice, resultRevision).out))
  ensures (inv(c) ==> canFinish(c, invoice, resultRevision) ==> stepAllowanceAdjustedOnceByAPaidUpgrade(c, finish(c, invoice, resultRevision).state, finish(c, invoice, resultRevision).out))
  ensures (inv(c) ==> canFinish(c, invoice, resultRevision) ==> stepDowngradeScheduledOnApply(c, finish(c, invoice, resultRevision).state, finish(c, invoice, resultRevision).out))
{
  if inv(c) && canFinish(c, invoice, resultRevision) {
    var done := finish(c, invoice, resultRevision);
    var ending := outcomeOf(c, invoice);
    var released := ReleaseSlot(c.commandId);
    assert holdsSlot(c);
    assert !c.phase.Applied?;
    assert done.state.phase == ending;
    assert namesCommand(done.state, released);
    if ending.Applied? && c.kind.UpgradeCommand? {
      var adjusted := AdjustAllowance(c.quote.targetPlanKey, c.quote.effectiveAt, c.quote.adjustment);
      assert quoteFits(c.kind, c.quote);
      assert adjustsAsQuoted(done.state, adjusted);
      assert done.out == [adjusted, released];
      assert adjusted in done.out && released in done.out;
      assert forall e :: e in done.out ==> e == adjusted || e == released;
    } else if ending.Applied? && c.kind.DowngradeCommand? {
      var scheduled := ScheduleDowngrade(c.commandId, c.quote.targetPlanKey);
      assert namesCommand(done.state, scheduled) && schedulesAsQuoted(done.state, scheduled);
      assert done.out == [scheduled, released];
      assert done.out[0] == scheduled;
      assert scheduled in done.out && released in done.out;
      assert forall e :: e in done.out ==> e == scheduled || e == released;
    } else if ending.AwaitingPayment? {
      assert done.out == [];
    } else {
      assert done.out == [released];
      assert released in done.out;
      assert forall e :: e in done.out ==> e == released;
    }
    assert stepSlotFollowsTheCommand(c, done.state, done.out);
    assert stepAllowanceAdjustedOnceByAPaidUpgrade(c, done.state, done.out);
    assert stepDowngradeScheduledOnApply(c, done.state, done.out);
  }
}
