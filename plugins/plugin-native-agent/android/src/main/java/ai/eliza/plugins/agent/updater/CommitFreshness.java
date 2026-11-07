package ai.eliza.plugins.agent.updater;

/** The metadata-freshness bounds EvaluatePreparedForCommit applies to a commit.
 * Both constants are owner defaults. Together they bound commit time minus
 * refresh time, so a revocation published before a commit is missed only when
 * it is newer than MAX_COMMIT_STALENESS_MS plus MAX_ACTIVATION_RUN_MS. */
public final class CommitFreshness {
 /** How much older, in trusted time, the lane's last metadata refresh may be
  * than the start of the activation run that commits. 0: the run must refresh
  * (PreparationFlow.Ports.refresh) before it commits. */
 public static final long MAX_COMMIT_STALENESS_MS=0;
 /** The longest an activation run may take from its start to the commit: the
  * refresh (a 3-minute discovery lease), idle and lease checks and writing the
  * install session. A run that takes longer is refused and must start again. */
 public static final long MAX_ACTIVATION_RUN_MS=10*60*1000;
 /** No bound on refresh or commit time: the periodic recheck of a VERIFIED plan
  * asks only whether the plan can still install at all. */
 public static final CommitFreshness UNBOUNDED=new CommitFreshness(0,0);
 /** The oldest refresh the commit accepts, and the latest trusted upper bound
  * at which it may commit; 0 is no bound. */
 public final long refreshedAfterLowerMs,commitByUpperMs;
 private CommitFreshness(long refreshedAfterLowerMs,long commitByUpperMs){this.refreshedAfterLowerMs=refreshedAfterLowerMs;this.commitByUpperMs=commitByUpperMs;}
 /** activationStartedLowerMs is the trusted lower bound read when the
  * activation run began, before it refreshed metadata. */
 public static CommitFreshness forActivation(long activationStartedLowerMs){
  if(activationStartedLowerMs<1||activationStartedLowerMs>QualifiedClockAnchor.MAX-MAX_ACTIVATION_RUN_MS)throw new IllegalArgumentException("Activation start time required");
  return new CommitFreshness(Math.max(1,activationStartedLowerMs-MAX_COMMIT_STALENESS_MS),activationStartedLowerMs+MAX_ACTIVATION_RUN_MS);
 }
}
