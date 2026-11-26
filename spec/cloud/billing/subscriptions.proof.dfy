lemma reconcile_ensures(s: Subscription, subscriptionId: string, providerStatus: ProviderStatus, latestInvoice: LatestInvoice, invoiceId: string, planKey: cloud__billing__plans_PlanKey, periodStart: int, periodEnd: int, cancelAtPeriodEnd: bool, now: int)
  ensures (inv(s) ==> canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) ==> alwaysSubscriptionHasIdPlanAndCustomer(reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).state))
  ensures (inv(s) ==> canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) ==> alwaysDunningWindowOnlyWhileDunning(reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).state))
  ensures (inv(s) ==> canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) ==> alwaysPlannedDowngradeIsLower(reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).state))
  ensures (inv(s) ==> canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) ==> alwaysLiveCommandFitsTheSubscription(reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).state))
  ensures (inv(s) ==> canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) ==> alwaysControlMatchesTheCommand(reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).state))
  ensures (inv(s) ==> canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) ==> stepCustomerPinnedOnce(s, reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).state))
  ensures (inv(s) ==> canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) ==> stepDunningWindowSetOnce(s, reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).state))
  ensures (inv(s) ==> canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) ==> stepLapsedNeverReturnsToDunning(s, reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).state))
  ensures (inv(s) ==> canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) ==> stepEndedNeverRewritten(s, reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).state))
  ensures (inv(s) ==> canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) ==> stepEndingClosesPeriods(s, reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).state, reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).out))
  ensures (inv(s) ==> canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) ==> stepRenewalOpensOncePerInvoice(s, reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).state, reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).out))
  ensures (inv(s) ==> canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) ==> stepRevisionCountsChanges(s, reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).state))
  ensures (inv(s) ==> canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) ==> stepPolicyFollowsTheSubscription(s, reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).state, reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now).out))
{
  if inv(s) && canReconcile(s, subscriptionId, planKey, periodStart, periodEnd, now) {
    var after := reconcile(s, subscriptionId, providerStatus, latestInvoice, invoiceId, planKey, periodStart, periodEnd, cancelAtPeriodEnd, now);
    var status := observedStatus(s, providerStatus, latestInvoice, now);
    if status.Active? && latestInvoice.PeriodInvoicePaid? && invoiceId != "" && invoiceId != s.lastRenewalInvoice {
      var opening := OpenRenewalPeriod(invoiceId, planKey, periodStart, periodEnd);
      assert !isEnded(status);
      assert after.state.lastRenewalInvoice == invoiceId && after.state.status == status;
      assert cloud__billing__allowance_canOpenRenewal(cloud__billing__allowance_initial, invoiceId, planKey, periodStart, periodEnd);
      assert renewalOpens(s, after.state, opening) && isRenewalOpening(opening);
      assert after.out == [opening, SubscriptionEffect.PolicyChanged];
      assert opening in after.out;
      assert forall each :: each in after.out ==> each == opening || each == SubscriptionEffect.PolicyChanged;
    } else {
      assert after.state.lastRenewalInvoice == s.lastRenewalInvoice;
      assert forall each :: each in after.out ==> each == SubscriptionEffect.CloseRenewalPeriods || each == SubscriptionEffect.PolicyChanged;
    }
    assert stepRenewalOpensOncePerInvoice(s, after.state, after.out);
  }
}
