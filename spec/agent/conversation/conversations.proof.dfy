lemma ConvHeadRule(c: Conversations)
  ensures alwaysOneRunningMutationAtTheHead(c) == ((!(c.running) || (|c.queue| > 0)) && (c.room <= c.roomSequence) && (c.roomSequence >= 0) && (|ProofLib.Filter((j: Job) => j.deletion, c.queue)| <= 1) && (!(deletionQueued(c)) || (c.room >= 0)) && (c.nextJob > 0) && (forall j :: j in c.queue ==> (j.jobId > 0) && (j.jobId < c.nextJob)))
{}

lemma ConvDeletions(xs: seq<Job>)
  ensures |ProofLib.Filter((j: Job) => j.deletion, xs)| == 0 <==> !(exists j :: j in xs && j.deletion)
{
  ProofLib.FilterNone((j: Job) => j.deletion, xs);
}

lemma ConvSameShape(c: Conversations, after: Conversations)
  requires inv(c)
  requires |after.queue| == |c.queue|
  requires forall i :: 0 <= i < |c.queue| ==> after.queue[i].jobId == c.queue[i].jobId && after.queue[i].deletion == c.queue[i].deletion
  requires after.running == c.running && after.room == c.room && after.roomSequence == c.roomSequence && after.nextJob == c.nextJob
  ensures alwaysOneRunningMutationAtTheHead(after)
{
  ConvHeadRule(c);
  ConvHeadRule(after);
  ProofLib.FilterLengthPointwise((j: Job) => j.deletion, (j: Job) => j.deletion, c.queue, after.queue);
  forall j | j in after.queue ensures j.jobId > 0 && j.jobId < after.nextJob {
    var i :| 0 <= i < |after.queue| && after.queue[i] == j;
    assert c.queue[i] in c.queue;
  }
  if deletionQueued(after) {
    var j :| j in after.queue && j.deletion;
    var i :| 0 <= i < |after.queue| && after.queue[i] == j;
    assert c.queue[i] in c.queue;
  }
}

lemma ConvPopped(c: Conversations, after: Conversations)
  requires inv(c) && |c.queue| > 0
  requires after.queue == c.queue[1..] && !after.running
  requires after.room == (if c.queue[0].deletion then -1 else c.room)
  requires after.roomSequence == c.roomSequence && after.nextJob == c.nextJob
  ensures alwaysOneRunningMutationAtTheHead(after)
{
  ConvHeadRule(c);
  ConvHeadRule(after);
  ProofLib.FilterCons((j: Job) => j.deletion, c.queue);
  assert c.queue == [c.queue[0]] + c.queue[1..];
  if c.queue[0].deletion {
    ConvDeletions(after.queue);
  }
}

lemma ConvAppended(c: Conversations, after: Conversations, job: Job)
  requires inv(c)
  requires after.queue == c.queue + [job] && after.running == c.running
  requires job.jobId == c.nextJob && after.nextJob == c.nextJob + 1
  requires after.room <= after.roomSequence && after.roomSequence >= c.roomSequence
  requires job.deletion ==> !deletionQueued(c) && after.room >= 0
  requires !job.deletion ==> after.room == c.room
  ensures alwaysOneRunningMutationAtTheHead(after)
{
  ConvHeadRule(c);
  ConvHeadRule(after);
  ProofLib.FilterAppend((j: Job) => j.deletion, c.queue, job);
  ConvDeletions(c.queue);
}

lemma enqueueMutation_ensures(c: Conversations)
  ensures (inv(c) ==> canEnqueueMutation(c) ==> alwaysOneRunningMutationAtTheHead(enqueueMutation(c)))
  ensures (inv(c) ==> canEnqueueMutation(c) ==> alwaysReadyOnlyForCurrentDescriptor(enqueueMutation(c)))
  ensures (inv(c) ==> canEnqueueMutation(c) ==> alwaysTombstoneWins(enqueueMutation(c)))
  ensures (inv(c) ==> canEnqueueMutation(c) ==> alwaysRejectedCreationHoldsNoRoom(enqueueMutation(c)))
  ensures (inv(c) ==> canEnqueueMutation(c) ==> stepRoomTokensAreNeverReused(c, enqueueMutation(c)))
  ensures (inv(c) ==> canEnqueueMutation(c) ==> stepTimedOutMutationNeverStarts(c, "enqueueMutation", enqueueMutation(c)))
  ensures (inv(c) ==> canEnqueueMutation(c) ==> stepCreationAcceptedOnlyWhenCurrent(c, "enqueueMutation", enqueueMutation(c)))
{
  if inv(c) && canEnqueueMutation(c) {
    ConvAppended(c, enqueueMutation(c), Job(c.nextJob, c.captured, c.capturedProof, false, false, false));
  }
}

lemma joinMutation_ensures(c: Conversations, jobId: int)
  ensures (inv(c) ==> canJoinMutation(c, jobId) ==> alwaysOneRunningMutationAtTheHead(joinMutation(c, jobId)))
  ensures (inv(c) ==> canJoinMutation(c, jobId) ==> alwaysReadyOnlyForCurrentDescriptor(joinMutation(c, jobId)))
  ensures (inv(c) ==> canJoinMutation(c, jobId) ==> alwaysTombstoneWins(joinMutation(c, jobId)))
  ensures (inv(c) ==> canJoinMutation(c, jobId) ==> alwaysRejectedCreationHoldsNoRoom(joinMutation(c, jobId)))
  ensures (inv(c) ==> canJoinMutation(c, jobId) ==> stepRoomTokensAreNeverReused(c, joinMutation(c, jobId)))
  ensures (inv(c) ==> canJoinMutation(c, jobId) ==> stepTimedOutMutationNeverStarts(c, "joinMutation", joinMutation(c, jobId)))
  ensures (inv(c) ==> canJoinMutation(c, jobId) ==> stepCreationAcceptedOnlyWhenCurrent(c, "joinMutation", joinMutation(c, jobId)))
{
  if inv(c) && canJoinMutation(c, jobId) {
    ConvSameShape(c, joinMutation(c, jobId));
  }
}

lemma skipMutation_ensures(c: Conversations)
  ensures (inv(c) ==> canSkipMutation(c) ==> alwaysOneRunningMutationAtTheHead(skipMutation(c)))
  ensures (inv(c) ==> canSkipMutation(c) ==> alwaysReadyOnlyForCurrentDescriptor(skipMutation(c)))
  ensures (inv(c) ==> canSkipMutation(c) ==> alwaysTombstoneWins(skipMutation(c)))
  ensures (inv(c) ==> canSkipMutation(c) ==> alwaysRejectedCreationHoldsNoRoom(skipMutation(c)))
  ensures (inv(c) ==> canSkipMutation(c) ==> stepRoomTokensAreNeverReused(c, skipMutation(c)))
  ensures (inv(c) ==> canSkipMutation(c) ==> stepTimedOutMutationNeverStarts(c, "skipMutation", skipMutation(c)))
  ensures (inv(c) ==> canSkipMutation(c) ==> stepCreationAcceptedOnlyWhenCurrent(c, "skipMutation", skipMutation(c)))
{
  if inv(c) && canSkipMutation(c) {
    ConvPopped(c, skipMutation(c));
  }
}

lemma settleMutation_ensures(c: Conversations, ok: bool)
  ensures (inv(c) ==> canSettleMutation(c) ==> alwaysOneRunningMutationAtTheHead(settleMutation(c, ok)))
  ensures (inv(c) ==> canSettleMutation(c) ==> alwaysReadyOnlyForCurrentDescriptor(settleMutation(c, ok)))
  ensures (inv(c) ==> canSettleMutation(c) ==> alwaysTombstoneWins(settleMutation(c, ok)))
  ensures (inv(c) ==> canSettleMutation(c) ==> alwaysRejectedCreationHoldsNoRoom(settleMutation(c, ok)))
  ensures (inv(c) ==> canSettleMutation(c) ==> stepRoomTokensAreNeverReused(c, settleMutation(c, ok)))
  ensures (inv(c) ==> canSettleMutation(c) ==> stepTimedOutMutationNeverStarts(c, "settleMutation", settleMutation(c, ok)))
  ensures (inv(c) ==> canSettleMutation(c) ==> stepCreationAcceptedOnlyWhenCurrent(c, "settleMutation", settleMutation(c, ok)))
{
  if inv(c) && canSettleMutation(c) {
    ConvPopped(c, settleMutation(c, ok));
  }
}

lemma enqueueDeletion_ensures(c: Conversations)
  ensures (inv(c) ==> canEnqueueDeletion(c) ==> alwaysOneRunningMutationAtTheHead(enqueueDeletion(c)))
  ensures (inv(c) ==> canEnqueueDeletion(c) ==> alwaysReadyOnlyForCurrentDescriptor(enqueueDeletion(c)))
  ensures (inv(c) ==> canEnqueueDeletion(c) ==> alwaysTombstoneWins(enqueueDeletion(c)))
  ensures (inv(c) ==> canEnqueueDeletion(c) ==> alwaysRejectedCreationHoldsNoRoom(enqueueDeletion(c)))
  ensures (inv(c) ==> canEnqueueDeletion(c) ==> stepRoomTokensAreNeverReused(c, enqueueDeletion(c)))
  ensures (inv(c) ==> canEnqueueDeletion(c) ==> stepTimedOutMutationNeverStarts(c, "enqueueDeletion", enqueueDeletion(c)))
  ensures (inv(c) ==> canEnqueueDeletion(c) ==> stepCreationAcceptedOnlyWhenCurrent(c, "enqueueDeletion", enqueueDeletion(c)))
{
  if inv(c) && canEnqueueDeletion(c) {
    ConvAppended(c, enqueueDeletion(c), noJob.(jobId := c.nextJob, deletion := true));
  }
}

lemma timeOutMutation_ensures(c: Conversations, jobId: int)
  ensures (inv(c) ==> canTimeOutMutation(c, jobId) ==> alwaysOneRunningMutationAtTheHead(timeOutMutation(c, jobId)))
  ensures (inv(c) ==> canTimeOutMutation(c, jobId) ==> alwaysReadyOnlyForCurrentDescriptor(timeOutMutation(c, jobId)))
  ensures (inv(c) ==> canTimeOutMutation(c, jobId) ==> alwaysTombstoneWins(timeOutMutation(c, jobId)))
  ensures (inv(c) ==> canTimeOutMutation(c, jobId) ==> alwaysRejectedCreationHoldsNoRoom(timeOutMutation(c, jobId)))
  ensures (inv(c) ==> canTimeOutMutation(c, jobId) ==> stepRoomTokensAreNeverReused(c, timeOutMutation(c, jobId)))
  ensures (inv(c) ==> canTimeOutMutation(c, jobId) ==> stepTimedOutMutationNeverStarts(c, "timeOutMutation", timeOutMutation(c, jobId)))
  ensures (inv(c) ==> canTimeOutMutation(c, jobId) ==> stepCreationAcceptedOnlyWhenCurrent(c, "timeOutMutation", timeOutMutation(c, jobId)))
{
  if inv(c) && canTimeOutMutation(c, jobId) {
    ConvSameShape(c, timeOutMutation(c, jobId));
  }
}
