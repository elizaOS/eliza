lemma LifecycleLookup(l: Lifecycle, mutation: string)
  ensures lifecycleReceipt(l, mutation) == (if |ProofLib.Filter((row: LifecycleReceipt) => (row.mutation == mutation), l.receipts)| > 0 then ProofLib.Filter((row: LifecycleReceipt) => (row.mutation == mutation), l.receipts)[0] else noReceipt)
{}

lemma LifecycleUnique(l: Lifecycle)
  ensures alwaysMutationsHaveUniqueKeys(l) == (forall row :: row in l.receipts ==> |ProofLib.Filter((other: LifecycleReceipt) => (other.mutation == row.mutation), l.receipts)| == 1)
{}

lemma LifecycleLookupFacts(l: Lifecycle, mutation: string)
  requires mutation != ""
  ensures lifecycleReceipt(l, mutation).mutation == "" ==> forall row :: row in l.receipts ==> row.mutation != mutation
  ensures lifecycleReceipt(l, mutation).mutation != "" ==> lifecycleReceipt(l, mutation) in l.receipts && lifecycleReceipt(l, mutation).mutation == mutation
{
  LifecycleLookup(l, mutation);
  var selected := ProofLib.Filter((row: LifecycleReceipt) => (row.mutation == mutation), l.receipts);
  if |selected| > 0 {
    ProofLib.FilterMember((row: LifecycleReceipt) => (row.mutation == mutation), l.receipts, selected[0]);
  } else {
    forall row | row in l.receipts ensures row.mutation != mutation {
      ProofLib.FilterMember((row: LifecycleReceipt) => (row.mutation == mutation), l.receipts, row);
    }
  }
}

lemma changeLifecycle_ensures(l: Lifecycle, by_: string, mutation: string, operation: LifecycleAction, expected: int)
  ensures (inv(l) ==> alwaysDefinitionIsOwned(changeLifecycle(l, by_, mutation, operation, expected)))
  ensures (inv(l) ==> alwaysRemovedInactive(changeLifecycle(l, by_, mutation, operation, expected)))
  ensures (inv(l) ==> alwaysReceiptVersionsMatch(changeLifecycle(l, by_, mutation, operation, expected)))
  ensures (inv(l) ==> alwaysPublishedReceiptIsExact(changeLifecycle(l, by_, mutation, operation, expected)))
  ensures (inv(l) ==> alwaysMutationsHaveUniqueKeys(changeLifecycle(l, by_, mutation, operation, expected)))
  ensures (inv(l) ==> stepRemovalDoesNotCancelRuns(l, "changeLifecycle", changeLifecycle(l, by_, mutation, operation, expected)))
{
  if inv(l) && l.owner != "" && by_ == l.owner && mutation != "" {
    var after := changeLifecycle(l, by_, mutation, operation, expected);
    LifecycleLookupFacts(l, mutation);
    if after.reply.SavedLifecycle? {
      var saved := LifecycleReceipt(mutation, operation, expected, l.version + 1);
      assert after.receipts == l.receipts + [saved];
      assert saved in after.receipts;
      LifecycleUnique(l); LifecycleUnique(after);
      forall row | row in after.receipts
        ensures |ProofLib.Filter((other: LifecycleReceipt) => (other.mutation == row.mutation), after.receipts)| == 1
      {
        ProofLib.FilterAppend((other: LifecycleReceipt) => (other.mutation == row.mutation), l.receipts, saved);
        if row == saved {
          assert forall prior :: prior in l.receipts ==> prior.mutation != row.mutation;
          ProofLib.FilterNone((other: LifecycleReceipt) => (other.mutation == row.mutation), l.receipts);
        } else {
          assert row in l.receipts;
          assert row.mutation != saved.mutation;
        }
      }
    }
  }
}
