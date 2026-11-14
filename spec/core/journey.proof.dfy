lemma observeModel_ensures(j: Journey, resultKind: core__models_Outcome)
  ensures (inv(j) ==> canObserveModel(j, resultKind) ==> alwaysTurnAccounting(observeModel(j, resultKind)))
  ensures (inv(j) ==> canObserveModel(j, resultKind) ==> alwaysActiveTurnAfterInitialization(observeModel(j, resultKind)))
  ensures (inv(j) ==> canObserveModel(j, resultKind) ==> alwaysBeforeSettlementHasNoActionOutcome(observeModel(j, resultKind)))
  ensures (inv(j) ==> canObserveModel(j, resultKind) ==> alwaysReplyInFlightBelongsToTurn(observeModel(j, resultKind)))
  ensures (inv(j) ==> canObserveModel(j, resultKind) ==> alwaysRuntimeRules(observeModel(j, resultKind)))
  ensures (inv(j) ==> canObserveModel(j, resultKind) ==> alwaysPreservedContext(observeModel(j, resultKind)))
  ensures (inv(j) ==> canObserveModel(j, resultKind) ==> alwaysRequestContextMatches(observeModel(j, resultKind)))
  ensures (inv(j) ==> canObserveModel(j, resultKind) ==> alwaysActionFailureHasNoReceipt(observeModel(j, resultKind)))
  ensures (inv(j) ==> canObserveModel(j, resultKind) ==> alwaysHonestRequest(observeModel(j, resultKind)))
  ensures (inv(j) ==> canObserveModel(j, resultKind) ==> alwaysHonestConfirmation(observeModel(j, resultKind)))
  ensures (inv(j) ==> canObserveModel(j, resultKind) ==> alwaysDrainedRetirement(observeModel(j, resultKind)))
{
  if inv(j) && canObserveModel(j, resultKind) {
    assert core__models_inv(j.model);
    assert core__models_canObserveOutcome(j.model, resultKind);
    core__models_observeOutcome_ensures(j.model, resultKind);
    var after := observeModel(j, resultKind);
    assert core__models_inv(after.model);
  }
}
