lemma start_ensures(c: Checkout, by_: core__sessions_SessionOwner, sub: cloud__billing__subscriptions_Subscription, commandId: string, planKey: cloud__billing__plans_PlanKey, presentation: Presentation, billingReturn: cloud__nativeClients__registry_ReturnUrl, digest: string, accountActive: bool)
  ensures (inv(c) ==> canStart(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive) ==> alwaysContractIsBound(start(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive).state))
  ensures (inv(c) ==> canStart(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive) ==> alwaysPhaseFollowsTheReceipt(start(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive).state))
  ensures (inv(c) ==> canStart(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive) ==> alwaysOnlyACompletedCheckoutHasASubscription(start(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive).state))
  ensures (inv(c) ==> canStart(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive) ==> stepContractIsFixed(c, start(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive).state))
  ensures (inv(c) ==> canStart(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive) ==> stepReceiptKeepsItsRules(c, "start", start(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive).state))
  ensures (inv(c) ==> canStart(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive) ==> stepEndsAreFinal(c, start(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive).state))
  ensures (inv(c) ==> canStart(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive) ==> stepReadBacksWaitTheirTurn(c, "start", start(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive).state))
  ensures (inv(c) ==> canStart(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive) ==> stepSlotFollowsTheCheckout(c, start(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive).state, start(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive).out))
{
  if inv(c) && canStart(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive) {
    var res := start(c, by_, sub, commandId, planKey, presentation, billingReturn, digest, accountActive);
    if |res.out| > 0 {
      assert res.out[0] in res.out;
    }
  }
}

lemma receiveReply_ensures(c: Checkout, reply: cloud__shared__dispatchOnce_ProviderReply, sessionId: string)
  ensures (inv(c) ==> canReceiveReply(c, reply, sessionId) ==> alwaysContractIsBound(receiveReply(c, reply, sessionId).state))
  ensures (inv(c) ==> canReceiveReply(c, reply, sessionId) ==> alwaysPhaseFollowsTheReceipt(receiveReply(c, reply, sessionId).state))
  ensures (inv(c) ==> canReceiveReply(c, reply, sessionId) ==> alwaysOnlyACompletedCheckoutHasASubscription(receiveReply(c, reply, sessionId).state))
  ensures (inv(c) ==> canReceiveReply(c, reply, sessionId) ==> stepContractIsFixed(c, receiveReply(c, reply, sessionId).state))
  ensures (inv(c) ==> canReceiveReply(c, reply, sessionId) ==> stepReceiptKeepsItsRules(c, "receiveReply", receiveReply(c, reply, sessionId).state))
  ensures (inv(c) ==> canReceiveReply(c, reply, sessionId) ==> stepEndsAreFinal(c, receiveReply(c, reply, sessionId).state))
  ensures (inv(c) ==> canReceiveReply(c, reply, sessionId) ==> stepReadBacksWaitTheirTurn(c, "receiveReply", receiveReply(c, reply, sessionId).state))
  ensures (inv(c) ==> canReceiveReply(c, reply, sessionId) ==> stepSlotFollowsTheCheckout(c, receiveReply(c, reply, sessionId).state, receiveReply(c, reply, sessionId).out))
{
  if inv(c) && canReceiveReply(c, reply, sessionId) {
    var res := receiveReply(c, reply, sessionId);
    if |res.out| > 0 {
      assert res.out[0] in res.out;
    }
  }
}

lemma resolve_ensures(c: Checkout, lookup: cloud__shared__dispatchOnce_LookupResult, sessionId: string)
  ensures (inv(c) ==> canResolve(c, lookup, sessionId) ==> alwaysContractIsBound(resolve(c, lookup, sessionId).state))
  ensures (inv(c) ==> canResolve(c, lookup, sessionId) ==> alwaysPhaseFollowsTheReceipt(resolve(c, lookup, sessionId).state))
  ensures (inv(c) ==> canResolve(c, lookup, sessionId) ==> alwaysOnlyACompletedCheckoutHasASubscription(resolve(c, lookup, sessionId).state))
  ensures (inv(c) ==> canResolve(c, lookup, sessionId) ==> stepContractIsFixed(c, resolve(c, lookup, sessionId).state))
  ensures (inv(c) ==> canResolve(c, lookup, sessionId) ==> stepReceiptKeepsItsRules(c, "resolve", resolve(c, lookup, sessionId).state))
  ensures (inv(c) ==> canResolve(c, lookup, sessionId) ==> stepEndsAreFinal(c, resolve(c, lookup, sessionId).state))
  ensures (inv(c) ==> canResolve(c, lookup, sessionId) ==> stepReadBacksWaitTheirTurn(c, "resolve", resolve(c, lookup, sessionId).state))
  ensures (inv(c) ==> canResolve(c, lookup, sessionId) ==> stepSlotFollowsTheCheckout(c, resolve(c, lookup, sessionId).state, resolve(c, lookup, sessionId).out))
{
  if inv(c) && canResolve(c, lookup, sessionId) {
    var res := resolve(c, lookup, sessionId);
    if |res.out| > 0 {
      assert res.out[0] in res.out;
    }
  }
}

lemma observePaid_ensures(c: Checkout, sessionId: string, subscriptionId: string)
  ensures (inv(c) ==> canObservePaid(c, sessionId, subscriptionId) ==> alwaysContractIsBound(observePaid(c, sessionId, subscriptionId).state))
  ensures (inv(c) ==> canObservePaid(c, sessionId, subscriptionId) ==> alwaysPhaseFollowsTheReceipt(observePaid(c, sessionId, subscriptionId).state))
  ensures (inv(c) ==> canObservePaid(c, sessionId, subscriptionId) ==> alwaysOnlyACompletedCheckoutHasASubscription(observePaid(c, sessionId, subscriptionId).state))
  ensures (inv(c) ==> canObservePaid(c, sessionId, subscriptionId) ==> stepContractIsFixed(c, observePaid(c, sessionId, subscriptionId).state))
  ensures (inv(c) ==> canObservePaid(c, sessionId, subscriptionId) ==> stepReceiptKeepsItsRules(c, "observePaid", observePaid(c, sessionId, subscriptionId).state))
  ensures (inv(c) ==> canObservePaid(c, sessionId, subscriptionId) ==> stepEndsAreFinal(c, observePaid(c, sessionId, subscriptionId).state))
  ensures (inv(c) ==> canObservePaid(c, sessionId, subscriptionId) ==> stepReadBacksWaitTheirTurn(c, "observePaid", observePaid(c, sessionId, subscriptionId).state))
  ensures (inv(c) ==> canObservePaid(c, sessionId, subscriptionId) ==> stepSlotFollowsTheCheckout(c, observePaid(c, sessionId, subscriptionId).state, observePaid(c, sessionId, subscriptionId).out))
{
  if inv(c) && canObservePaid(c, sessionId, subscriptionId) {
    var res := observePaid(c, sessionId, subscriptionId);
    if |res.out| > 0 {
      assert res.out[0] in res.out;
    }
  }
}

lemma observeExpired_ensures(c: Checkout, sessionId: string)
  ensures (inv(c) ==> canObserveExpired(c, sessionId) ==> alwaysContractIsBound(observeExpired(c, sessionId).state))
  ensures (inv(c) ==> canObserveExpired(c, sessionId) ==> alwaysPhaseFollowsTheReceipt(observeExpired(c, sessionId).state))
  ensures (inv(c) ==> canObserveExpired(c, sessionId) ==> alwaysOnlyACompletedCheckoutHasASubscription(observeExpired(c, sessionId).state))
  ensures (inv(c) ==> canObserveExpired(c, sessionId) ==> stepContractIsFixed(c, observeExpired(c, sessionId).state))
  ensures (inv(c) ==> canObserveExpired(c, sessionId) ==> stepReceiptKeepsItsRules(c, "observeExpired", observeExpired(c, sessionId).state))
  ensures (inv(c) ==> canObserveExpired(c, sessionId) ==> stepEndsAreFinal(c, observeExpired(c, sessionId).state))
  ensures (inv(c) ==> canObserveExpired(c, sessionId) ==> stepReadBacksWaitTheirTurn(c, "observeExpired", observeExpired(c, sessionId).state))
  ensures (inv(c) ==> canObserveExpired(c, sessionId) ==> stepSlotFollowsTheCheckout(c, observeExpired(c, sessionId).state, observeExpired(c, sessionId).out))
{
  if inv(c) && canObserveExpired(c, sessionId) {
    var res := observeExpired(c, sessionId);
    if |res.out| > 0 {
      assert res.out[0] in res.out;
    }
  }
}
