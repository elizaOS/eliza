lemma PrivacyJobBridge(s: PrivacyService)
  ensures alwaysJobIdsAreUnique(s) <==>
    (forall job :: job in s.jobs ==> (job.id != "" && |ProofLib.Filter((other: PiiJob) => other.id == job.id, s.jobs)| == 1))
{}

lemma PrivacyWaiterBridge(s: PrivacyService)
  ensures alwaysPromiseIdentitiesAreValid(s) <==>
    (s.nextPromise > 0 && 0 <= s.startId < s.nextPromise && 0 <= s.stopId < s.nextPromise && (s.startPending ==> s.startId > 0) &&
     (forall waiter :: waiter in s.stopWaiters ==> (0 < waiter.id < s.nextPromise && |ProofLib.Filter((other: StopWaiter) => other.id == waiter.id, s.stopWaiters)| == 1)))
{}

lemma PrivacyJobs(s: PrivacyService,t: PrivacyService)
  requires inv(s)
  requires |s.jobs| <= |t.jobs| <= |s.jobs|+1
  requires forall i :: 0 <= i < |s.jobs| ==> s.jobs[i].id == t.jobs[i].id
  requires |s.jobs| != |t.jobs| ==> !(exists job :: job in s.jobs && job.id == t.jobs[|s.jobs|].id)
  requires forall job :: job in t.jobs ==> job.id != ""
  ensures alwaysJobIdsAreUnique(t)
  ensures forall id :: jobAt(s,id).id != "" ==> jobAt(t,id).id == id
{
  PrivacyJobBridge(s); PrivacyJobBridge(t);
  forall i,j | 0 <= i < |t.jobs| && 0 <= j < |t.jobs| && i != j
    ensures t.jobs[i].id != t.jobs[j].id
  {
    if i < |s.jobs| && j < |s.jobs| {
      var job := s.jobs[i];
      assert job in s.jobs;
      ProofLib.FilterCountOneIffUnique((other: PiiJob) => other.id == job.id,s.jobs,(other: PiiJob) => other.id,i);
    }
  }
  forall job | job in t.jobs
    ensures |ProofLib.Filter((other: PiiJob) => other.id == job.id,t.jobs)| == 1
  {
    var i :| 0 <= i < |t.jobs| && t.jobs[i] == job;
    ProofLib.FilterOne((other: PiiJob) => other.id == job.id,t.jobs,i);
  }
  forall id | jobAt(s,id).id != "" ensures jobAt(t,id).id == id {
    var oldJob := jobAt(s,id);
    PrivacyLookup(s,id);
    var i :| 0 <= i < |s.jobs| && s.jobs[i] == oldJob;
    assert t.jobs[i] in t.jobs;
    PrivacyFind(t,t.jobs[i]);
  }
}

lemma PrivacyLookup(s: PrivacyService,id: string)
  ensures jobAt(s,id) == emptyJob || (jobAt(s,id) in s.jobs && jobAt(s,id).id == id)
{
  var matches := ProofLib.Filter((job: PiiJob) => job.id == id,s.jobs);
  if |matches| > 0 { ProofLib.FilterMember((job: PiiJob) => job.id == id,s.jobs,matches[0]); }
}

lemma PrivacyFind(s: PrivacyService,job: PiiJob)
  requires alwaysJobIdsAreUnique(s) && job in s.jobs
  ensures jobAt(s,job.id) == job
{
  PrivacyJobBridge(s);
  var id := job.id;
  var rs := ProofLib.Filter((job: PiiJob) => job.id == id,s.jobs);
  ProofLib.FilterMember((job: PiiJob) => job.id == id,s.jobs,job);
  assert |rs| == 1;
  assert rs[0] == job;
}

lemma PrivacyWaiters(s: PrivacyService, t: PrivacyService)
  requires inv(s)
  requires |s.stopWaiters| <= |t.stopWaiters| <= |s.stopWaiters|+1
  requires forall i :: 0 <= i < |s.stopWaiters| ==> s.stopWaiters[i].id == t.stopWaiters[i].id
  requires |s.stopWaiters| != |t.stopWaiters| ==> t.stopWaiters[|s.stopWaiters|].id == s.nextPromise
  requires t.nextPromise >= s.nextPromise
  requires 0 <= t.startId < t.nextPromise && 0 <= t.stopId < t.nextPromise && (t.startPending ==> t.startId > 0)
  requires |s.stopWaiters| != |t.stopWaiters| ==> t.nextPromise > s.nextPromise
  ensures alwaysPromiseIdentitiesAreValid(t)
{
  PrivacyWaiterBridge(s); PrivacyWaiterBridge(t);
  forall i,j | 0 <= i < |t.stopWaiters| && 0 <= j < |t.stopWaiters| && i != j
    ensures t.stopWaiters[i].id != t.stopWaiters[j].id
  {
    if i < |s.stopWaiters| && j < |s.stopWaiters| {
      var w := s.stopWaiters[i]; assert w in s.stopWaiters;
      ProofLib.FilterCountOneIffUnique((other: StopWaiter) => other.id == w.id,s.stopWaiters,(other: StopWaiter) => other.id,i);
    } else if i < |s.stopWaiters| { assert s.stopWaiters[i] in s.stopWaiters; }
    else { assert s.stopWaiters[j] in s.stopWaiters; }
  }
  forall w | w in t.stopWaiters
    ensures 0 < w.id < t.nextPromise && |ProofLib.Filter((other: StopWaiter) => other.id == w.id,t.stopWaiters)| == 1
  {
    var i :| 0 <= i < |t.stopWaiters| && t.stopWaiters[i] == w;
    if i < |s.stopWaiters| { assert s.stopWaiters[i] in s.stopWaiters; }
    ProofLib.FilterOne((other: StopWaiter) => other.id == w.id,t.stopWaiters,i);
  }
}

lemma PrivacyWorkMap(s: PrivacyService,t: PrivacyService)
  requires inv(s)
  requires |s.jobs| == |t.jobs|
  requires forall i :: 0 <= i < |s.jobs| ==> s.jobs[i].id == t.jobs[i].id
  requires forall i :: 0 <= i < |t.jobs| ==> (core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
    core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
    core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
    (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers))
  ensures alwaysEveryJobRetainsSettlement(t) && alwaysCommittedJobHasSharedMarker(t)
  ensures alwaysJobIdsAreUnique(t)
  ensures forall id :: jobAt(s,id).id != "" ==> jobAt(t,id).id == id
{
  forall job | job in t.jobs
    ensures job.id != "" && core__privacy_alwaysAcceptedWorkIsAccounted(job.work) &&
      core__privacy_alwaysCompletionRequiresPersistentMarker(job.work) &&
      core__privacy_alwaysCountsAreNonnegative(job.work) && (job.work.marker ==> job.key in t.markers)
  {
    var i :| 0 <= i < |t.jobs| && t.jobs[i] == job;
    assert s.jobs[i] in s.jobs;
  }
  PrivacyJobs(s,t);
}

lemma PrivacyAtEntry(s: PrivacyService, j: PiiJob, id: string)
  requires alwaysJobIdsAreUnique(s)
  requires j in s.jobs && j.id == id
  ensures jobAt(s,id) == j
{
  PrivacyFind(s,j);
}

lemma PrivacyBatchSplit(xs: seq<core__priorityQueue_QueueItem>, base: core__priorityQueue_ItemSplit, limit: int)
  ensures forall job :: job in Std.Collections.Seq.FoldLeft((acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(limit, acc, job), base, xs).taken ==> (job in xs || job in base.taken)
  ensures forall job :: job in Std.Collections.Seq.FoldLeft((acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(limit, acc, job), base, xs).kept ==> (job in xs || job in base.kept)
  decreases |xs|
{
  reveal Std.Collections.Seq.FoldLeft();
  var apply := (acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(limit, acc, job);
  var combined := Std.Collections.Seq.FoldLeft(apply,base,xs);
  if |xs| == 0 {
    assert combined == base;
  } else {
    var first := xs[0];
    var tail := xs[1..];
    var refined := core__priorityQueue_splitItem(limit,base,first);
    assert combined == Std.Collections.Seq.FoldLeft(apply,refined,tail);
    PrivacyBatchSplit(tail,refined,limit);
    forall job | job in combined.taken
      ensures job in xs || job in base.taken
    {
      assert job in tail || job in refined.taken;
      if job in tail { assert job in xs; }
      else { assert refined.taken == base.taken || refined.taken == base.taken + [first]; }
    }
    forall job | job in combined.kept
      ensures job in xs || job in base.kept
    {
      assert job in tail || job in refined.kept;
      if job in tail { assert job in xs; }
      else { assert refined.kept == base.kept || refined.kept == base.kept + [first]; }
    }
  }
}

lemma PrivacyQueueSubset(s: core__priorityQueue_PriorityState, limit: int, tickets: seq<int>)
  ensures forall job :: job in core__priorityQueue_queuedItems(core__priorityQueue_dequeue(s,limit)) ==> job in core__priorityQueue_queuedItems(s)
  ensures forall job :: job in core__priorityQueue_dequeue(s,limit).lastRemoved ==> job in core__priorityQueue_queuedItems(s)
  ensures forall job :: job in core__priorityQueue_queuedItems(core__priorityQueue_drainTickets(s,tickets)) ==> job in core__priorityQueue_queuedItems(s)
{
  PrivacyBatchSplit(core__priorityQueue_queuedItems(s),core__priorityQueue_emptyItemSplit,limit);
  var split := core__priorityQueue_splitQueue(s,limit);
  forall job | job in core__priorityQueue_queuedItems(core__priorityQueue_dequeue(s,limit))
    ensures job in core__priorityQueue_queuedItems(s)
  {
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => j.priority.High?,split.kept,job);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => j.priority.Normal?,split.kept,job);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => j.priority.Low?,split.kept,job);
  }
  forall job | job in core__priorityQueue_queuedItems(core__priorityQueue_drainTickets(s,tickets))
    ensures job in core__priorityQueue_queuedItems(s)
  {
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !(j.ticket in tickets),s.high,job);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !(j.ticket in tickets),s.normal,job);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !(j.ticket in tickets),s.low,job);
  }
}

lemma PrivacyTicketLookup(s: PrivacyService, ticket: int)
  ensures ticketJob(s,ticket) == emptyJob || ticketJob(s,ticket) in s.jobs
{
  var matches := ProofLib.Filter((active: core__batchQueue_BatchItem) => active.ticket == ticket,s.queue.active+s.queue.flush);
  if |matches| > 0 { PrivacyLookup(s,matches[0].payload); }
  else { PrivacyLookup(s,emptyBatchTicket.payload); }
}

lemma request_ensures(s: PrivacyService, id: string, key: string, priority: core__priorityQueue_QueuePriority)
  ensures (inv(s) ==> canRequest(s, id, key, priority) ==> alwaysPromiseIdentitiesAreValid(request(s, id, key, priority)))
  ensures (inv(s) ==> canRequest(s, id, key, priority) ==> alwaysEveryJobRetainsSettlement(request(s, id, key, priority)))
  ensures (inv(s) ==> canRequest(s, id, key, priority) ==> alwaysCommittedJobHasSharedMarker(request(s, id, key, priority)))
  ensures (inv(s) ==> canRequest(s, id, key, priority) ==> alwaysJobIdsAreUnique(request(s, id, key, priority)))
  ensures (inv(s) ==> canRequest(s, id, key, priority) ==> alwaysQueueReferencesKnownJobs(request(s, id, key, priority)))
  ensures (inv(s) ==> canRequest(s, id, key, priority) ==> stepJoiningStopKeepsIdentity(s, "request", request(s, id, key, priority)))
{
  if inv(s) && canRequest(s, id, key, priority) {
    var t := request(s, id, key, priority);
    PrivacyLookup(s,id);
    forall job | job in s.jobs ensures job.id != id {
      if job.id == id { PrivacyAtEntry(s,job,id); }
    }
    PrivacyJobs(s,t);
  }
}

lemma finishAdmission_ensures(s: PrivacyService, id: string)
  ensures (inv(s) ==> canFinishAdmission(s, id) ==> alwaysPromiseIdentitiesAreValid(finishAdmission(s, id)))
  ensures (inv(s) ==> canFinishAdmission(s, id) ==> alwaysEveryJobRetainsSettlement(finishAdmission(s, id)))
  ensures (inv(s) ==> canFinishAdmission(s, id) ==> alwaysCommittedJobHasSharedMarker(finishAdmission(s, id)))
  ensures (inv(s) ==> canFinishAdmission(s, id) ==> alwaysJobIdsAreUnique(finishAdmission(s, id)))
  ensures (inv(s) ==> canFinishAdmission(s, id) ==> alwaysQueueReferencesKnownJobs(finishAdmission(s, id)))
  ensures (inv(s) ==> canFinishAdmission(s, id) ==> stepJoiningStopKeepsIdentity(s, "finishAdmission", finishAdmission(s, id)))
{
  if inv(s) && canFinishAdmission(s, id) {
    var t := finishAdmission(s, id);
    PrivacyLookup(s,id);
    forall i | 0 <= i < |t.jobs|
      ensures core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
        core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
        core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
        (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers)
    {
      var job := s.jobs[i];
      assert job in s.jobs;
      if job.id == id {
        PrivacyAtEntry(s,job,id);
        core__privacy_finishAdmission_ensures(job.work);
      }
    }
    PrivacyWorkMap(s,t);
    PrivacyWaiters(s,t);
  }
}

lemma scrubbed_ensures(s: PrivacyService, id: string)
  ensures (inv(s) ==> canScrubbed(s, id) ==> alwaysPromiseIdentitiesAreValid(scrubbed(s, id)))
  ensures (inv(s) ==> canScrubbed(s, id) ==> alwaysEveryJobRetainsSettlement(scrubbed(s, id)))
  ensures (inv(s) ==> canScrubbed(s, id) ==> alwaysCommittedJobHasSharedMarker(scrubbed(s, id)))
  ensures (inv(s) ==> canScrubbed(s, id) ==> alwaysJobIdsAreUnique(scrubbed(s, id)))
  ensures (inv(s) ==> canScrubbed(s, id) ==> alwaysQueueReferencesKnownJobs(scrubbed(s, id)))
  ensures (inv(s) ==> canScrubbed(s, id) ==> stepJoiningStopKeepsIdentity(s, "scrubbed", scrubbed(s, id)))
{
  if inv(s) && canScrubbed(s, id) {
    var t := scrubbed(s, id);
    PrivacyLookup(s,id);
    forall i | 0 <= i < |t.jobs|
      ensures core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
        core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
        core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
        (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers)
    {
      var job := s.jobs[i];
      assert job in s.jobs;
      if job.id == id {
        PrivacyAtEntry(s,job,id);
        core__privacy_scrubbed_ensures(job.work);
      }
    }
    PrivacyWorkMap(s,t);
  }
}

lemma persistMap_ensures(s: PrivacyService, id: string)
  ensures (inv(s) ==> canPersistMap(s, id) ==> alwaysPromiseIdentitiesAreValid(persistMap(s, id)))
  ensures (inv(s) ==> canPersistMap(s, id) ==> alwaysEveryJobRetainsSettlement(persistMap(s, id)))
  ensures (inv(s) ==> canPersistMap(s, id) ==> alwaysCommittedJobHasSharedMarker(persistMap(s, id)))
  ensures (inv(s) ==> canPersistMap(s, id) ==> alwaysJobIdsAreUnique(persistMap(s, id)))
  ensures (inv(s) ==> canPersistMap(s, id) ==> alwaysQueueReferencesKnownJobs(persistMap(s, id)))
  ensures (inv(s) ==> canPersistMap(s, id) ==> stepJoiningStopKeepsIdentity(s, "persistMap", persistMap(s, id)))
{
  if inv(s) && canPersistMap(s, id) {
    var t := persistMap(s, id);
    PrivacyLookup(s,id);
    forall i | 0 <= i < |t.jobs|
      ensures core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
        core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
        core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
        (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers)
    {
      var job := s.jobs[i];
      assert job in s.jobs;
      if job.id == id {
        PrivacyAtEntry(s,job,id);
        core__privacy_persistMap_ensures(job.work);
      }
    }
    PrivacyWorkMap(s,t);
  }
}

lemma confirmMarker_ensures(s: PrivacyService, id: string)
  ensures (inv(s) ==> canConfirmMarker(s, id) ==> alwaysPromiseIdentitiesAreValid(confirmMarker(s, id)))
  ensures (inv(s) ==> canConfirmMarker(s, id) ==> alwaysEveryJobRetainsSettlement(confirmMarker(s, id)))
  ensures (inv(s) ==> canConfirmMarker(s, id) ==> alwaysCommittedJobHasSharedMarker(confirmMarker(s, id)))
  ensures (inv(s) ==> canConfirmMarker(s, id) ==> alwaysJobIdsAreUnique(confirmMarker(s, id)))
  ensures (inv(s) ==> canConfirmMarker(s, id) ==> alwaysQueueReferencesKnownJobs(confirmMarker(s, id)))
  ensures (inv(s) ==> canConfirmMarker(s, id) ==> stepJoiningStopKeepsIdentity(s, "confirmMarker", confirmMarker(s, id)))
{
  if inv(s) && canConfirmMarker(s, id) {
    var t := confirmMarker(s, id);
    PrivacyLookup(s,id);
    forall key | key in s.markers ensures key in t.markers {
      ProofLib.FilterMember((set_x: string) => !(set_x in s.markers), [jobAt(s,id).key], key);
    }
    forall i | 0 <= i < |t.jobs|
      ensures core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
        core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
        core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
        (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers)
    {
      var job := s.jobs[i];
      assert job in s.jobs;
      if job.id == id {
        PrivacyAtEntry(s,job,id);
        core__privacy_confirmMarker_ensures(job.work);
        ProofLib.FilterMember((set_x: string) => !(set_x in s.markers), [job.key], job.key);
      }
    }
    PrivacyWorkMap(s,t);
  }
}

lemma observeCompletion_ensures(s: PrivacyService, id: string, observerSucceeded: bool)
  ensures (inv(s) ==> canObserveCompletion(s, id, observerSucceeded) ==> alwaysPromiseIdentitiesAreValid(observeCompletion(s, id, observerSucceeded)))
  ensures (inv(s) ==> canObserveCompletion(s, id, observerSucceeded) ==> alwaysEveryJobRetainsSettlement(observeCompletion(s, id, observerSucceeded)))
  ensures (inv(s) ==> canObserveCompletion(s, id, observerSucceeded) ==> alwaysCommittedJobHasSharedMarker(observeCompletion(s, id, observerSucceeded)))
  ensures (inv(s) ==> canObserveCompletion(s, id, observerSucceeded) ==> alwaysJobIdsAreUnique(observeCompletion(s, id, observerSucceeded)))
  ensures (inv(s) ==> canObserveCompletion(s, id, observerSucceeded) ==> alwaysQueueReferencesKnownJobs(observeCompletion(s, id, observerSucceeded)))
  ensures (inv(s) ==> canObserveCompletion(s, id, observerSucceeded) ==> stepJoiningStopKeepsIdentity(s, "observeCompletion", observeCompletion(s, id, observerSucceeded)))
{
  if inv(s) && canObserveCompletion(s, id, observerSucceeded) {
    var t := observeCompletion(s, id, observerSucceeded);
    PrivacyLookup(s,id);
    forall i | 0 <= i < |t.jobs|
      ensures core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
        core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
        core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
        (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers)
    {
      var job := s.jobs[i];
      assert job in s.jobs;
      if job.id == id {
        PrivacyAtEntry(s,job,id);
        core__privacy_observeCompletion_ensures(job.work,observerSucceeded);
      }
    }
    PrivacyWorkMap(s,t);
  }
}

lemma finishAttempt_ensures(s: PrivacyService, ticket: int, ok: bool, retry: bool)
  ensures (inv(s) ==> canFinishAttempt(s, ticket, ok, retry) ==> alwaysPromiseIdentitiesAreValid(finishAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishAttempt(s, ticket, ok, retry) ==> alwaysEveryJobRetainsSettlement(finishAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishAttempt(s, ticket, ok, retry) ==> alwaysCommittedJobHasSharedMarker(finishAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishAttempt(s, ticket, ok, retry) ==> alwaysJobIdsAreUnique(finishAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishAttempt(s, ticket, ok, retry) ==> alwaysQueueReferencesKnownJobs(finishAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishAttempt(s, ticket, ok, retry) ==> stepJoiningStopKeepsIdentity(s, "finishAttempt", finishAttempt(s, ticket, ok, retry)))
{
  if inv(s) && canFinishAttempt(s, ticket, ok, retry) {
    var t := finishAttempt(s, ticket, ok, retry);
    PrivacyTicketLookup(s,ticket);
    forall i | 0 <= i < |t.jobs|
      ensures core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
        core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
        core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
        (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers)
    {
      var job := s.jobs[i];
      assert job in s.jobs;
      if job.id == ticketJob(s,ticket).id && !ok && retry { core__privacy_attemptFailed_ensures(job.work); }
    }
    PrivacyWorkMap(s,t);
  }
}

lemma driveQueue_ensures(s: PrivacyService, queueEvent: PiiQueueEvent, ticket: int, ok: bool)
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok) ==> alwaysPromiseIdentitiesAreValid(driveQueue(s, queueEvent, ticket, ok)))
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok) ==> alwaysEveryJobRetainsSettlement(driveQueue(s, queueEvent, ticket, ok)))
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok) ==> alwaysCommittedJobHasSharedMarker(driveQueue(s, queueEvent, ticket, ok)))
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok) ==> alwaysJobIdsAreUnique(driveQueue(s, queueEvent, ticket, ok)))
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok) ==> alwaysQueueReferencesKnownJobs(driveQueue(s, queueEvent, ticket, ok)))
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok) ==> stepJoiningStopKeepsIdentity(s, "driveQueue", driveQueue(s, queueEvent, ticket, ok)))
{
  if inv(s) && canDriveQueue(s, queueEvent, ticket, ok) {
    var t := driveQueue(s, queueEvent, ticket, ok);
    PrivacyTicketLookup(s,ticket);
    PrivacyQueueSubset(s.queue.queue,s.queue.batchSize,[]);
    forall i | 0 <= i < |t.jobs|
      ensures core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
        core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
        core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
        (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers)
    {
      var job := s.jobs[i];
      assert job in s.jobs;
      if queueEvent.StartAttempt? && job.id == ticketJob(s,ticket).id {
        var w := if job.key in s.markers then job.work.(marker := true,mapPersisted := true) else job.work;
        core__privacy_drain_ensures(w);
      }
    }
    PrivacyWorkMap(s,t);
    PrivacyWaiters(s,t);
  }
}

lemma stop_ensures(s: PrivacyService)
  ensures (inv(s) ==> alwaysPromiseIdentitiesAreValid(stop(s)))
  ensures (inv(s) ==> alwaysEveryJobRetainsSettlement(stop(s)))
  ensures (inv(s) ==> alwaysCommittedJobHasSharedMarker(stop(s)))
  ensures (inv(s) ==> alwaysJobIdsAreUnique(stop(s)))
  ensures (inv(s) ==> alwaysQueueReferencesKnownJobs(stop(s)))
  ensures (inv(s) ==> stepJoiningStopKeepsIdentity(s, "stop", stop(s)))
{
  if inv(s) && true {
    var t := stop(s);
    forall i | 0 <= i < |t.jobs|
      ensures core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
        core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
        core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
        (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers)
    {
      var job := s.jobs[i];
      assert job in s.jobs;
      if job.work.life.Open? { core__privacy_stop_ensures(job.work); }
    }
    PrivacyWorkMap(s,t);
    PrivacyWaiters(s,t);
  }
}

lemma completeStop_ensures(s: PrivacyService)
  ensures (inv(s) ==> canCompleteStop(s) ==> alwaysPromiseIdentitiesAreValid(completeStop(s)))
  ensures (inv(s) ==> canCompleteStop(s) ==> alwaysEveryJobRetainsSettlement(completeStop(s)))
  ensures (inv(s) ==> canCompleteStop(s) ==> alwaysCommittedJobHasSharedMarker(completeStop(s)))
  ensures (inv(s) ==> canCompleteStop(s) ==> alwaysJobIdsAreUnique(completeStop(s)))
  ensures (inv(s) ==> canCompleteStop(s) ==> alwaysQueueReferencesKnownJobs(completeStop(s)))
  ensures (inv(s) ==> canCompleteStop(s) ==> stepJoiningStopKeepsIdentity(s, "completeStop", completeStop(s)))
{
  if inv(s) && canCompleteStop(s) {
    var t := completeStop(s);
    forall i | 0 <= i < |t.jobs|
      ensures core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
        core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
        core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
        (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers)
    {
      var job := s.jobs[i];
      assert job in s.jobs;
      if core__privacy_canDispose(job.work) { core__privacy_dispose_ensures(job.work); }
    }
    PrivacyWorkMap(s,t);
    PrivacyWaiters(s,t);
  }
}

lemma beginDisposal_ensures(s: PrivacyService, fast: bool)
  ensures (inv(s) ==> canBeginDisposal(s, fast) ==> alwaysPromiseIdentitiesAreValid(beginDisposal(s, fast)))
  ensures (inv(s) ==> canBeginDisposal(s, fast) ==> alwaysEveryJobRetainsSettlement(beginDisposal(s, fast)))
  ensures (inv(s) ==> canBeginDisposal(s, fast) ==> alwaysCommittedJobHasSharedMarker(beginDisposal(s, fast)))
  ensures (inv(s) ==> canBeginDisposal(s, fast) ==> alwaysJobIdsAreUnique(beginDisposal(s, fast)))
  ensures (inv(s) ==> canBeginDisposal(s, fast) ==> alwaysQueueReferencesKnownJobs(beginDisposal(s, fast)))
  ensures (inv(s) ==> canBeginDisposal(s, fast) ==> stepJoiningStopKeepsIdentity(s, "beginDisposal", beginDisposal(s, fast)))
{
  if inv(s) && canBeginDisposal(s, fast) {
    var t := beginDisposal(s, fast);
    if !fast {
      var tickets := Std.Collections.Seq.FoldLeft((tickets: seq<int>, j: core__priorityQueue_QueueItem) => (tickets + Std.Collections.Seq.Filter((set_x: int) => !((set_x in tickets)), [j.ticket])), [], s.queue.queue.high);
      PrivacyQueueSubset(s.queue.queue,s.queue.batchSize,tickets);
    }
    forall i | 0 <= i < |t.jobs|
      ensures core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
        core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
        core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
        (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers)
    {
      var job := s.jobs[i];
      assert job in s.jobs;

    }
    PrivacyWorkMap(s,t);
    PrivacyWaiters(s,t);
  }
}

lemma finalizeLateJob_ensures(s: PrivacyService, id: string)
  ensures (inv(s) ==> canFinalizeLateJob(s, id) ==> alwaysPromiseIdentitiesAreValid(finalizeLateJob(s, id)))
  ensures (inv(s) ==> canFinalizeLateJob(s, id) ==> alwaysEveryJobRetainsSettlement(finalizeLateJob(s, id)))
  ensures (inv(s) ==> canFinalizeLateJob(s, id) ==> alwaysCommittedJobHasSharedMarker(finalizeLateJob(s, id)))
  ensures (inv(s) ==> canFinalizeLateJob(s, id) ==> alwaysJobIdsAreUnique(finalizeLateJob(s, id)))
  ensures (inv(s) ==> canFinalizeLateJob(s, id) ==> alwaysQueueReferencesKnownJobs(finalizeLateJob(s, id)))
  ensures (inv(s) ==> canFinalizeLateJob(s, id) ==> stepJoiningStopKeepsIdentity(s, "finalizeLateJob", finalizeLateJob(s, id)))
{
  if inv(s) && canFinalizeLateJob(s, id) {
    var t := finalizeLateJob(s, id);
    PrivacyLookup(s,id);
    forall i | 0 <= i < |t.jobs|
      ensures core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
        core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
        core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
        (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers)
    {
      var job := s.jobs[i];
      assert job in s.jobs;
      if job.id == id {
        PrivacyAtEntry(s,job,id);
        core__privacy_dispose_ensures(job.work);
      }
    }
    PrivacyWorkMap(s,t);
  }
}

lemma finishUrgentItem_ensures(s: PrivacyService, ok: bool)
  ensures (inv(s) ==> canFinishUrgentItem(s, ok) ==> alwaysPromiseIdentitiesAreValid(finishUrgentItem(s, ok)))
  ensures (inv(s) ==> canFinishUrgentItem(s, ok) ==> alwaysEveryJobRetainsSettlement(finishUrgentItem(s, ok)))
  ensures (inv(s) ==> canFinishUrgentItem(s, ok) ==> alwaysCommittedJobHasSharedMarker(finishUrgentItem(s, ok)))
  ensures (inv(s) ==> canFinishUrgentItem(s, ok) ==> alwaysJobIdsAreUnique(finishUrgentItem(s, ok)))
  ensures (inv(s) ==> canFinishUrgentItem(s, ok) ==> alwaysQueueReferencesKnownJobs(finishUrgentItem(s, ok)))
  ensures (inv(s) ==> canFinishUrgentItem(s, ok) ==> stepJoiningStopKeepsIdentity(s, "finishUrgentItem", finishUrgentItem(s, ok)))
{
  if inv(s) && canFinishUrgentItem(s, ok) {
    var t := finishUrgentItem(s, ok);
    PrivacyTicketLookup(s,s.flushTicket);
    forall i | 0 <= i < |t.jobs|
      ensures core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
        core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
        core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
        (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers)
    {
      var job := s.jobs[i];
      assert job in s.jobs;

    }
    PrivacyWorkMap(s,t);
  }
}

lemma beginUrgentItem_ensures(s: PrivacyService)
  ensures (inv(s) ==> canBeginUrgentItem(s) ==> alwaysPromiseIdentitiesAreValid(beginUrgentItem(s)))
  ensures (inv(s) ==> canBeginUrgentItem(s) ==> alwaysEveryJobRetainsSettlement(beginUrgentItem(s)))
  ensures (inv(s) ==> canBeginUrgentItem(s) ==> alwaysCommittedJobHasSharedMarker(beginUrgentItem(s)))
  ensures (inv(s) ==> canBeginUrgentItem(s) ==> alwaysJobIdsAreUnique(beginUrgentItem(s)))
  ensures (inv(s) ==> canBeginUrgentItem(s) ==> alwaysQueueReferencesKnownJobs(beginUrgentItem(s)))
  ensures (inv(s) ==> canBeginUrgentItem(s) ==> stepJoiningStopKeepsIdentity(s, "beginUrgentItem", beginUrgentItem(s)))
{
  if inv(s) && canBeginUrgentItem(s) {
    var t := beginUrgentItem(s);
    PrivacyTicketLookup(s,urgentTicket(s));
    forall i | 0 <= i < |t.jobs|
      ensures core__privacy_alwaysAcceptedWorkIsAccounted(t.jobs[i].work) &&
        core__privacy_alwaysCompletionRequiresPersistentMarker(t.jobs[i].work) &&
        core__privacy_alwaysCountsAreNonnegative(t.jobs[i].work) &&
        (t.jobs[i].work.marker ==> t.jobs[i].key in t.markers)
    {
      var job := s.jobs[i];
      assert job in s.jobs;
      if job.id == ticketJob(s,urgentTicket(s)).id {
        var w := if job.key in s.markers then job.work.(marker := true,mapPersisted := true) else job.work;
        core__privacy_drain_ensures(w);
      }
    }
    PrivacyWorkMap(s,t);
  }
}
