// Allocation identity, per-scope exclusion and dynamically selected progress.

lemma admit_ensures(s: ConnectorQueues, scope: QueueScope)
  ensures (inv(s) ==> alwaysOneRunningPerScope(admit(s, scope)))
  ensures (inv(s) ==> alwaysAllocatedTickets(admit(s, scope)))
  ensures (inv(s) ==> alwaysCompletedEntrySettled(admit(s, scope)))
  ensures (inv(s) ==> alwaysStartedAfterPredecessors(admit(s, scope)))
  ensures (inv(s) ==> stepCleanupKeepsUnsettledTails(s, "admit", admit(s, scope)))
{
  if inv(s) {
    var after := admit(s, scope);
    QueueTicketFacts(s);
    ProofLib.DistinctByConcat(s.entries, [QueueEntry(scope, s.serial, false, false, false)], (entry: QueueEntry) => entry.ticket);
    QueueTicketFacts(after);
    QueueRunningFacts(s);
    QueueRunningFacts(after);
  }
}

lemma begin_ensures(s: ConnectorQueues, ticket: int)
  ensures (inv(s) ==> canBegin(s, ticket) ==> alwaysOneRunningPerScope(begin(s, ticket)))
  ensures (inv(s) ==> canBegin(s, ticket) ==> alwaysAllocatedTickets(begin(s, ticket)))
  ensures (inv(s) ==> canBegin(s, ticket) ==> alwaysCompletedEntrySettled(begin(s, ticket)))
  ensures (inv(s) ==> canBegin(s, ticket) ==> alwaysStartedAfterPredecessors(begin(s, ticket)))
  ensures (inv(s) ==> canBegin(s, ticket) ==> stepCleanupKeepsUnsettledTails(s, "begin", begin(s, ticket)))
{
  if inv(s) && canBegin(s, ticket) {
    var after := begin(s, ticket);
    QueueMapTickets(s, after);
    QueueTicketFacts(s);
    QueueRunningFacts(s);
    var chosen :| chosen in s.entries && chosen.ticket == ticket && !chosen.running && !chosen.complete && (forall prior :: prior in s.entries ==> prior.scope != chosen.scope || prior.ticket >= chosen.ticket || prior.complete);
    forall other | other in s.entries && other.running ensures other.scope != chosen.scope {
      if other.scope == chosen.scope {
        if other.ticket < chosen.ticket { assert other.complete; }
        else if other.ticket > chosen.ticket { assert chosen.complete; }
        else {
          var i :| 0 <= i < |s.entries| && s.entries[i] == chosen;
          var j :| 0 <= j < |s.entries| && s.entries[j] == other;
          assert i == j;
        }
      }
    }
    QueueRunningFacts(after);
  }
}

lemma finish_ensures(s: ConnectorQueues, ticket: int, success: bool)
  ensures (inv(s) ==> canFinish(s, ticket) ==> alwaysOneRunningPerScope(finish(s, ticket, success)))
  ensures (inv(s) ==> canFinish(s, ticket) ==> alwaysAllocatedTickets(finish(s, ticket, success)))
  ensures (inv(s) ==> canFinish(s, ticket) ==> alwaysCompletedEntrySettled(finish(s, ticket, success)))
  ensures (inv(s) ==> canFinish(s, ticket) ==> alwaysStartedAfterPredecessors(finish(s, ticket, success)))
  ensures (inv(s) ==> canFinish(s, ticket) ==> stepCleanupKeepsUnsettledTails(s, "finish", finish(s, ticket, success)))
{
  if inv(s) && canFinish(s, ticket) {
    var after := finish(s, ticket, success);
    QueueMapTickets(s, after);
    QueueRunningFacts(s);
    QueueRunningFacts(after);
  }
}

lemma cleanup_ensures(s: ConnectorQueues, ticket: int)
  ensures (inv(s) ==> canCleanup(s, ticket) ==> alwaysOneRunningPerScope(cleanup(s, ticket)))
  ensures (inv(s) ==> canCleanup(s, ticket) ==> alwaysAllocatedTickets(cleanup(s, ticket)))
  ensures (inv(s) ==> canCleanup(s, ticket) ==> alwaysCompletedEntrySettled(cleanup(s, ticket)))
  ensures (inv(s) ==> canCleanup(s, ticket) ==> alwaysStartedAfterPredecessors(cleanup(s, ticket)))
  ensures (inv(s) ==> canCleanup(s, ticket) ==> stepCleanupKeepsUnsettledTails(s, "cleanup", cleanup(s, ticket)))
{
  if inv(s) && canCleanup(s, ticket) {
    var after := cleanup(s, ticket);
    forall tail | tail in s.tails && tail.ticket != ticket ensures tail in after.tails {
      ProofLib.FilterMember((queuedTail: QueueTail) => (queuedTail.ticket != ticket), s.tails, tail);
    }
  }
}

lemma beginNext_ensures(s: ConnectorQueues)
  ensures (inv(s) ==> canBeginNext(s) ==> alwaysOneRunningPerScope(beginNext(s)))
  ensures (inv(s) ==> canBeginNext(s) ==> alwaysAllocatedTickets(beginNext(s)))
  ensures (inv(s) ==> canBeginNext(s) ==> alwaysCompletedEntrySettled(beginNext(s)))
  ensures (inv(s) ==> canBeginNext(s) ==> alwaysStartedAfterPredecessors(beginNext(s)))
  ensures (inv(s) ==> canBeginNext(s) ==> stepCleanupKeepsUnsettledTails(s, "beginNext", beginNext(s)))
{
  if inv(s) && canBeginNext(s) {
    QueueFirstEligible(s);
    begin_ensures(s, firstEligible(s));
  }
}

lemma finishNext_ensures(s: ConnectorQueues, success: bool)
  ensures (inv(s) ==> canFinishNext(s) ==> alwaysOneRunningPerScope(finishNext(s, success)))
  ensures (inv(s) ==> canFinishNext(s) ==> alwaysAllocatedTickets(finishNext(s, success)))
  ensures (inv(s) ==> canFinishNext(s) ==> alwaysCompletedEntrySettled(finishNext(s, success)))
  ensures (inv(s) ==> canFinishNext(s) ==> alwaysStartedAfterPredecessors(finishNext(s, success)))
  ensures (inv(s) ==> canFinishNext(s) ==> stepCleanupKeepsUnsettledTails(s, "finishNext", finishNext(s, success)))
{
  if inv(s) && canFinishNext(s) {
    QueueFirstRunning(s);
    finish_ensures(s, firstRunning(s), success);
  }
}

lemma QueueTicketFacts(s: ConnectorQueues)
  ensures alwaysAllocatedTickets(s) == (s.serial >= 1 && (forall entry :: entry in s.entries ==> entry.ticket > 0 && entry.ticket < s.serial) && ProofLib.DistinctBy(s.entries, (entry: QueueEntry) => entry.ticket))
{
  QueueAllocationShape(s);
  if alwaysAllocatedTickets(s) {
    forall i, j | 0 <= i < |s.entries| && 0 <= j < |s.entries| && i != j ensures s.entries[i].ticket != s.entries[j].ticket {
      ProofLib.FilterCountOneIffUnique((other: QueueEntry) => (other.ticket == s.entries[i].ticket), s.entries, (entry: QueueEntry) => entry.ticket, i);
    }
  } else if s.serial >= 1 && (forall entry :: entry in s.entries ==> entry.ticket > 0 && entry.ticket < s.serial) && ProofLib.DistinctBy(s.entries, (entry: QueueEntry) => entry.ticket) {
    forall entry | entry in s.entries ensures |ProofLib.Filter((other: QueueEntry) => (other.ticket == entry.ticket), s.entries)| == 1 {
      var i :| 0 <= i < |s.entries| && s.entries[i] == entry;
      ProofLib.FilterOne((other: QueueEntry) => (other.ticket == entry.ticket), s.entries, i);
    }
  }
}

lemma QueueAllocationShape(s: ConnectorQueues)
  ensures alwaysAllocatedTickets(s) == (s.serial >= 1 && (forall entry :: entry in s.entries ==> entry.ticket > 0 && entry.ticket < s.serial && |ProofLib.Filter((other: QueueEntry) => (other.ticket == entry.ticket), s.entries)| == 1))
{}

lemma QueueRunningShape(s: ConnectorQueues)
  ensures alwaysOneRunningPerScope(s) == (forall entry :: entry in s.entries && entry.running ==> |ProofLib.Filter((other: QueueEntry) => ((other.scope == entry.scope) && other.running), s.entries)| == 1)
{}

lemma QueueRunningFacts(s: ConnectorQueues)
  ensures alwaysOneRunningPerScope(s) == (forall i, j :: 0 <= i < |s.entries| && 0 <= j < |s.entries| && s.entries[i].running && s.entries[j].running && s.entries[i].scope == s.entries[j].scope ==> i == j)
{
  QueueRunningShape(s);
  if alwaysOneRunningPerScope(s) {
    forall i, j | 0 <= i < |s.entries| && 0 <= j < |s.entries| && s.entries[i].running && s.entries[j].running && s.entries[i].scope == s.entries[j].scope ensures i == j {
      if i != j { ProofLib.FilterTwo((other: QueueEntry) => ((other.scope == s.entries[i].scope) && other.running), s.entries, i, j); }
    }
  } else if forall i, j :: 0 <= i < |s.entries| && 0 <= j < |s.entries| && s.entries[i].running && s.entries[j].running && s.entries[i].scope == s.entries[j].scope ==> i == j {
    forall entry | entry in s.entries && entry.running ensures |ProofLib.Filter((other: QueueEntry) => ((other.scope == entry.scope) && other.running), s.entries)| == 1 {
      var i :| 0 <= i < |s.entries| && s.entries[i] == entry;
      ProofLib.FilterOne((other: QueueEntry) => ((other.scope == entry.scope) && other.running), s.entries, i);
    }
  }
}

lemma QueueMapTickets(before: ConnectorQueues, after: ConnectorQueues)
  requires alwaysAllocatedTickets(before) && before.serial == after.serial
  requires |before.entries| == |after.entries|
  requires forall i :: 0 <= i < |before.entries| ==> before.entries[i].ticket == after.entries[i].ticket
  ensures alwaysAllocatedTickets(after)
{
  QueueTicketFacts(before);
  forall i, j | 0 <= i < |after.entries| && 0 <= j < |after.entries| && i != j ensures after.entries[i].ticket != after.entries[j].ticket {}
  QueueTicketFacts(after);
}

lemma QueueFirstEligible(s: ConnectorQueues)
  requires canBeginNext(s)
  ensures canBegin(s, firstEligible(s))
{
  QueueSelectionShape(s);
  var e :| e in s.entries && canBegin(s, e.ticket);
  ProofLib.FilterMember((entry: QueueEntry) => canBegin(s, entry.ticket), s.entries, e);
  var selected := ProofLib.Filter((entry: QueueEntry) => canBegin(s, entry.ticket), s.entries);
  assert |selected| > 0;
  ProofLib.FilterMember((entry: QueueEntry) => canBegin(s, entry.ticket), s.entries, selected[0]);
}

lemma QueueFirstRunning(s: ConnectorQueues)
  requires canFinishNext(s)
  ensures canFinish(s, firstRunning(s))
{
  QueueSelectionShape(s);
  var e :| e in s.entries && canFinish(s, e.ticket);
  ProofLib.FilterMember((entry: QueueEntry) => canFinish(s, entry.ticket), s.entries, e);
  var selected := ProofLib.Filter((entry: QueueEntry) => canFinish(s, entry.ticket), s.entries);
  assert |selected| > 0;
  ProofLib.FilterMember((entry: QueueEntry) => canFinish(s, entry.ticket), s.entries, selected[0]);
}

lemma QueueSelectionShape(s: ConnectorQueues)
  ensures firstEligible(s) == (if |ProofLib.Filter((entry: QueueEntry) => canBegin(s, entry.ticket), s.entries)| > 0 then ProofLib.Filter((entry: QueueEntry) => canBegin(s, entry.ticket), s.entries)[0].ticket else 0)
  ensures firstRunning(s) == (if |ProofLib.Filter((entry: QueueEntry) => canFinish(s, entry.ticket), s.entries)| > 0 then ProofLib.Filter((entry: QueueEntry) => canFinish(s, entry.ticket), s.entries)[0].ticket else 0)
{}
