package ai.eliza.plugins.agent.updater;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/** Private supervisor journal. All mutations reload under an OS file lock and
 * publish through fsync + same-filesystem rename. This is not a trust verifier. */
public class UpdateJournal {
  public enum Phase { IDLE, STAGING, VERIFIED, COMMITTING, PROBATION, HEALTHY, RECOVERY_READY, RECOVERING, RECOVERY_PROBATION, RECOVERED, QUARANTINED, SUPPORT }
  public interface Durability { void syncDirectory(Path path) throws IOException; }
  public interface Faults { void boundary(String name) throws IOException; }
  public interface CommitAction { void commit() throws IOException; }
  /** Refuses, by throwing, a plan that may no longer install: admission is not
   * a lasting permission. It runs under the journal lock, before the install
   * intent is written, so a refusal leaves the plan VERIFIED. */
  public interface FreshnessCheck { void require(Plan plan,long channelGeneration) throws IOException; }
  /** What a finished install session reported. CANDIDATE_REJECTED is evidence
   * that the candidate itself cannot install here; RETRYABLE is a fault of the
   * moment, such as low storage. Hosts map platform statuses to these. */
  public enum InstallerFailure { CANDIDATE_REJECTED, RETRYABLE }
  /** The session is gone, the previous code still runs and nothing reported why. */
  public static final String OUTCOME_UNKNOWN="install_outcome_unknown";
  /** The install can no longer happen; the plan may be admitted again. */
  public static final String INSTALL_RELEASED="install_not_completed";
  /** The same candidate was released too often and is quarantined. */
  public static final String RETRY_BUDGET_SPENT="install_retry_budget_spent";
  /** Reasons a stalled install waits in SUPPORT for platform readback. */
  public static final Set<String> AWAITING_REASONS=Set.of("user_action_required","policy_blocked","install_timeout","install_clock_invalid",OUTCOME_UNKNOWN);
  /** Owner-overridable default: the observed uptime a gone session with no
   * report waits for a late installer callback before the plan is released.
   * One periodic reconciliation job interval. */
  public static final long OUTCOME_UNKNOWN_WAIT_MS=15*60*1000L;
  /** Owner-overridable default: a candidate whose install ends released this
   * many times in a row is quarantined, so a persistent policy block or full
   * storage cannot commit the same plan on every job run. */
  public static final int MAX_INSTALL_ATTEMPTS_PER_CANDIDATE=3;
  /** The platform handoff threw after the install intent was durable. The
   * platform may still install, so callers must not abandon the session
   * blindly; InstallReadback abandons it only once the platform has reported
   * it uncommitted for long enough, and installed and session readback decide
   * the outcome. */
  public static final class HandoffFailed extends IOException {
    HandoffFailed(Exception cause) { super("Platform handoff outcome unknown",cause); }
  }
  public static final class Identity {
    public final long code;
    public final String digest;
    public Identity(long code, String digest) {
      if (code < 1 || code > 2100000000L || digest == null || !digest.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid package identity");
      this.code = code; this.digest = digest;
    }
    public boolean matches(Identity other) { return other != null && code == other.code && digest.equals(other.digest); }
  }
  /** Created by the release admission layer after signature, compatibility and
   * candidate/recovery artifact verification. Journal enforces order and races. */
  public static final class Plan {
    public final String id, channel, distribution;
    public final Identity baseline, candidate, recovery;
    public Plan(String id, String channel, String distribution, Identity baseline, Identity candidate, Identity recovery) {
      if (id == null || !id.matches("[A-Za-z0-9._-]{1,96}") || !("stable".equals(channel) || "beta".equals(channel))
          || !("launcher".equals(distribution) || "standalone".equals(distribution)) || baseline == null || candidate == null || recovery == null
          || candidate.code <= baseline.code || recovery.code <= candidate.code || candidate.digest.equals(recovery.digest)) throw new IllegalArgumentException("Invalid update plan");
      this.id = id; this.channel = channel; this.distribution = distribution;
      this.baseline = baseline; this.candidate = candidate; this.recovery = recovery;
    }
  }
  /** Timing evidence only. Callers must qualify OS eligibility and local checks;
   * no sample here can itself authorize a healthy verdict or installation. */
  public enum ProbationKind { READY, LOCAL_FAILURE, PAUSED, UNKNOWN }
  public static final class ProbationPolicy {
    public final String id; public final long readyMillis,failureMillis,maxGapMillis;
    public ProbationPolicy(String id,long ready,long failure,long gap) {
      if(id==null||!id.matches("[a-f0-9]{64}")||gap<1||gap>60000||ready<gap||ready>86400000||failure<gap||failure>86400000)throw new IllegalArgumentException("Invalid probation policy");
      this.id=id;readyMillis=ready;failureMillis=failure;maxGapMillis=gap;
    }
    public boolean same(ProbationPolicy other){return other!=null&&id.equals(other.id)&&readyMillis==other.readyMillis&&failureMillis==other.failureMillis&&maxGapMillis==other.maxGapMillis;}
  }
  public static final class ProbationSample {
    public final long boot,elapsed; public final String process,runtime; public final ProbationKind kind;
    public ProbationSample(long boot,long elapsed,String process,String runtime,ProbationKind kind) {
      String uuid="[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
      if(boot<0||elapsed<0||kind==null||process==null||runtime==null||!(process.matches(uuid)||process.equals("none"))||!(runtime.matches(uuid)||runtime.equals("none"))||((kind==ProbationKind.READY||kind==ProbationKind.LOCAL_FAILURE)&&(process.equals("none")||runtime.equals("none"))))throw new IllegalArgumentException("Invalid probation sample");
      this.boot=boot;this.elapsed=elapsed;this.process=process;this.runtime=runtime;this.kind=kind;
    }
    public boolean sameLifetime(ProbationSample other){return other!=null&&boot==other.boot&&!process.equals("none")&&!runtime.equals("none")&&process.equals(other.process)&&runtime.equals(other.runtime);}
  }
  public static final class ProbationWindow {
    public final ProbationPolicy policy; public final ProbationSample last; public final long readyMillis,failureMillis;
    public ProbationWindow(ProbationPolicy policy,ProbationSample last,long ready,long failure) {
      this.policy=policy;this.last=last;readyMillis=ready;failureMillis=failure;
    }
    public boolean readyDurationReached(){return last.kind==ProbationKind.READY&&readyMillis>=policy.readyMillis;}
    public boolean failureDurationReached(){return last.kind==ProbationKind.LOCAL_FAILURE&&failureMillis>=policy.failureMillis;}
  }
  public static final class Snapshot {
    public final ProbationWindow probation;
    public final long revision, channelGeneration, pendingMillis;
    public final String channel, reason;
    public final Phase phase;
    public final Plan plan;
    public final int sessionId, recoveryAttempts;
    public final Set<String> quarantine;
    /** A failure reported while the session was still listed, applied once it is gone. */
    public final InstallerFailure reportedFailure;
    /** The candidate digest whose installs ended released, and how many times in a row. */
    public final String releasedCandidate;
    public final int releases;
    Snapshot(State s) {
      probation=s.probation; pendingMillis=s.pendingMillis; revision=s.revision; channelGeneration=s.generation; channel=s.channel; reason=s.reason; phase=s.phase; plan=s.plan;
      sessionId=s.session; recoveryAttempts=s.attempts; quarantine=Collections.unmodifiableSet(new HashSet<>(s.quarantine));
      reportedFailure=s.reported; releasedCandidate=s.releasedDigest; releases=s.releases;
    }
  }
  private static final class State {
    ProbationWindow probation;
    long pendingMillis=0, observedBoot=-1, observedElapsed=-1;
    long revision=0, generation=0; String channel="stable", reason=""; Phase phase=Phase.IDLE;
    Plan plan; int session=-1, attempts=0; Set<String> quarantine=new TreeSet<>();
    InstallerFailure reported; String releasedDigest=""; int releases=0;
    State copy() {
      State c=new State();c.probation=probation;c.pendingMillis=pendingMillis;c.observedBoot=observedBoot;c.observedElapsed=observedElapsed;
      c.revision=revision;c.generation=generation;c.channel=channel;c.reason=reason;c.phase=phase;c.plan=plan;c.session=session;c.attempts=attempts;c.quarantine=new TreeSet<>(quarantine);
      c.reported=reported;c.releasedDigest=releasedDigest;c.releases=releases;
      return c;
    }
  }
  private interface Mutation { void apply(State state) throws IOException; }
  private interface Locked<T> { T apply(State current) throws IOException; }
  /** Holds the encoded journal. The file store is the only production store. */
  interface Store {
    /** Runs body exclusively against every other instance on the same storage. */
    <T> T exclusive(Exclusive<T> body) throws IOException;
    /** The published envelope, or null on a device that never published one. */
    byte[] read() throws IOException;
    /** Atomically replaces the published envelope. */
    void publish(byte[] envelope) throws IOException;
  }
  interface Exclusive<T> { T run() throws IOException; }
  private final Store store;
  private static final int MAX_BYTES=1024*1024, MAGIC=0x53434f54, VERSION=5;
  public UpdateJournal(Path directory, Durability durability) throws IOException { this(directory,durability,name->{}); }
  public UpdateJournal(Path directory, Durability durability, Faults faults) throws IOException { this(new FileStore(directory,durability,faults)); }
  UpdateJournal(Store store) { this.store=Objects.requireNonNull(store); }
  public Snapshot read() throws IOException { return locked(Snapshot::new); }
  public interface SnapshotAction { void run(Snapshot snapshot) throws IOException; }
  /** Short private-storage operations only; never perform network I/O here. */
  public void withLockedSnapshot(SnapshotAction action)throws IOException {
    Objects.requireNonNull(action);
    locked(s->{action.run(new Snapshot(s));return null;});
  }
  public Snapshot setChannel(String channel) throws IOException {
    if (!"stable".equals(channel) && !"beta".equals(channel)) throw new IllegalArgumentException("Unknown update channel");
    return transact(s->{
      if (s.channel.equals(channel)) return;
      s.channel=channel; s.generation=increment(s.generation);s.probation=null;
      if (s.phase==Phase.VERIFIED || s.phase==Phase.STAGING) { s.phase=Phase.IDLE; s.plan=null; s.session=-1; s.reason="channel_changed"; }
    });
  }
  public Snapshot begin(Plan plan, Identity installed, long channelGeneration) throws IOException {
    return beginValidated(plan,installed,channelGeneration,()->{});
  }
  /** Validate retained authorization under the same lock used by cleanup. */
  public Snapshot beginValidated(Plan plan,Identity installed,long channelGeneration,CommitAction validate)throws IOException {
    return admitPrepared(plan,installed,channelGeneration,validate,Phase.VERIFIED);
  }
  public Snapshot stageValidated(Plan plan,Identity installed,long channelGeneration,CommitAction validate)throws IOException {
    return admitPrepared(plan,installed,channelGeneration,validate,Phase.STAGING);
  }
  private Snapshot admitPrepared(Plan plan,Identity installed,long channelGeneration,CommitAction validate,Phase phase)throws IOException {
    Objects.requireNonNull(validate);
    return transact(s->{
      require(!active(s.phase)||(phase==Phase.VERIFIED&&s.phase==Phase.STAGING&&samePlan(s.plan,plan)),"An update transaction is active");
      require(s.generation==channelGeneration,"Channel decision is stale");
      require(plan.baseline.matches(installed),"Installed baseline changed");
      require(s.channel.equals(plan.channel),"Update plan channel does not match requested channel");
      require(!s.quarantine.contains(plan.candidate.digest),"Candidate is quarantined");
      require(!s.quarantine.contains(plan.recovery.digest),"Recovery is quarantined");
      validate.commit();
      resetPending(s); s.probation=null; s.plan=plan; s.phase=phase; s.session=-1; s.attempts=0; s.reason=""; s.reported=null;
    });
  }
  private static boolean samePlan(Plan a,Plan b){return a!=null&&b!=null&&a.id.equals(b.id)&&a.channel.equals(b.channel)&&a.distribution.equals(b.distribution)&&a.baseline.matches(b.baseline)&&a.candidate.matches(b.candidate)&&a.recovery.matches(b.recovery);}
  /** Discard only an uncommitted queued download, never an install or recovery. */
  public Snapshot discardStaging(String planId,long generation)throws IOException {
    return transact(s->{requirePlan(s,planId);require(s.phase==Phase.STAGING&&s.generation==generation,"Stale staging discard");s.plan=null;s.phase=Phase.IDLE;s.session=-1;s.reason="staging_invalidated";resetPending(s);});
  }
  /** Serialize the freshness check, the durable intent and the platform handoff
   * with channel changes. This is the only way into COMMITTING. */
  public Snapshot committingWithAction(String planId,int sessionId,long channelGeneration,FreshnessCheck fresh,CommitAction action)throws IOException {
    Objects.requireNonNull(fresh);Objects.requireNonNull(action);
    return transact(s->{requirePlan(s,planId);require(s.phase==Phase.VERIFIED,"Candidate is not ready");require(s.generation==channelGeneration,"Channel changed before commit");require(sessionId>=0,"Invalid install session");fresh.require(s.plan,s.generation);s.session=sessionId;s.phase=Phase.COMMITTING;},action);
  }
  /** Drops a VERIFIED plan that a metadata refresh shows can no longer install.
   * Quarantine, floors and the channel generation stay. */
  public Snapshot discardVerified(String planId,long channelGeneration,String reason)throws IOException {
    requireReason(reason);
    return transact(s->{requirePlan(s,planId);require(s.phase==Phase.VERIFIED&&s.generation==channelGeneration,"Stale verified discard");s.plan=null;s.phase=Phase.IDLE;s.session=-1;s.reason="verified_invalidated:"+reason;resetPending(s);});
  }
  /** Ends a RECOVERY_READY wait for a recovery that revocations or floors have
   * made permanently unloadable. Both artifacts are quarantined, and the failed
   * candidate stays installed until a newer release fixes forward. */
  public Snapshot recoveryUnavailable(String planId,String reason)throws IOException {
    requireReason(reason);
    return transact(s->{requirePlan(s,planId);require(s.phase==Phase.RECOVERY_READY&&s.attempts==0,"Recovery already attempted or not ready");quarantine(s,true);s.phase=Phase.QUARANTINED;s.reason="recovery_unavailable:"+reason;});
  }
  private static void requireReason(String reason){if(reason==null||!reason.matches("[a-z][a-z-]{0,47}"))throw new IllegalArgumentException("Invalid journal reason");}
  public Snapshot recoveringWithAction(String planId,int sessionId,CommitAction action)throws IOException {
    Objects.requireNonNull(action);
    return transact(s->{requirePlan(s,planId);require(s.phase==Phase.RECOVERY_READY&&s.attempts==0,"Recovery already attempted or not ready");require(sessionId>=0,"Invalid recovery session");resetPending(s);s.session=sessionId;s.attempts=1;s.phase=Phase.RECOVERING;},action);
  }
  /** Platform readback, not a callback alone, determines which code was installed. */
  public Snapshot reconcile(Identity installed, boolean sessionPending) throws IOException {
    Snapshot state=read();
    return reconcile(state.plan==null?null:state.plan.id,state.sessionId,installed,sessionPending);
  }
  public Snapshot reconcile(String planId,int sessionId,Identity installed,boolean sessionPending) throws IOException {
    return reconcileInstallerResult(planId,sessionId,installed,sessionPending,null,null);
  }
  public Snapshot reconcileInstallerResult(String planId,int sessionId,Identity installed,boolean sessionPending,String blockedReason)throws IOException {
    return reconcileInstallerResult(planId,sessionId,installed,sessionPending,blockedReason,null);
  }
  /** Callback status is a hint; installed bytes and our live session win. A
   * blocked callback must not conceal a later successful platform commit.
   * Only a reported candidate fault quarantines, and a fault reported while
   * the session is still listed is kept until it is gone. A gone session with
   * no report waits OUTCOME_UNKNOWN_WAIT_MS of observed uptime
   * (observeOutcomeUnknown) for a late callback before the plan is released.
   * That wait holds the journal in SUPPORT, which admits no other plan, and
   * only observeOutcomeUnknown ends it: a host that calls this directly must
   * also run InstallReadback.reconcile periodically while awaitingInstaller. */
  public Snapshot reconcileInstallerResult(String planId,int sessionId,Identity installed,boolean sessionPending,String blockedReason,InstallerFailure failure)throws IOException {
    if(blockedReason!=null&&!Arrays.asList("user_action_required","policy_blocked").contains(blockedReason))throw new IllegalArgumentException("Unknown installer reason");
    return transact(s->{
      if(!awaitingInstaller(new Snapshot(s)))return;
      if(s.plan==null||!s.plan.id.equals(planId)||s.session!=sessionId)return;
      boolean wasBlocked=s.phase==Phase.SUPPORT;
      boolean recovering=s.phase==Phase.RECOVERING||(wasBlocked&&s.attempts==1);
      Identity expected=recovering?s.plan.recovery:s.plan.candidate;
      if(expected.matches(installed)){
        s.phase=recovering?Phase.RECOVERY_PROBATION:Phase.PROBATION;s.reason="";s.reported=null;
        // The candidate installed, so its releases are no longer in a row; the
        // cleared record also lets the journal be written as version 4 again.
        if(!recovering){s.releasedDigest="";s.releases=0;}
        return;
      }
      Identity previous=recovering?s.plan.candidate:s.plan.baseline;
      if(!previous.matches(installed)){s.phase=Phase.SUPPORT;s.reason="unexpected_installed_identity";return;}
      if(blockedReason!=null){s.phase=Phase.SUPPORT;s.reason=blockedReason;return;}
      if(sessionPending){if(!recovering)s.reported=stronger(s.reported,failure);return;}
      // The session is gone and the previous code still runs. Recovery is
      // attempted once, so a failed or stalled one stays in support.
      if(recovering){if(!wasBlocked){s.phase=Phase.SUPPORT;quarantine(s,false);s.reason="recovery_install_failed";}return;}
      InstallerFailure evidence=stronger(s.reported,failure);
      if(evidence==InstallerFailure.CANDIDATE_REJECTED){s.phase=Phase.QUARANTINED;quarantine(s,false);s.reason="candidate_install_failed";s.reported=null;return;}
      // A fault of the moment: the install can no longer happen, so release it.
      if(evidence==InstallerFailure.RETRYABLE){release(s);return;}
      if(wasBlocked&&OUTCOME_UNKNOWN.equals(s.reason))return;
      s.phase=Phase.SUPPORT;s.reason=OUTCOME_UNKNOWN;resetPending(s);
    });
  }
  private static InstallerFailure stronger(InstallerFailure a,InstallerFailure b){
    return a==InstallerFailure.CANDIDATE_REJECTED||b==InstallerFailure.CANDIDATE_REJECTED?InstallerFailure.CANDIDATE_REJECTED:a!=null?a:b;
  }
  public static boolean awaitingInstaller(Snapshot s) {
    return s.phase==Phase.COMMITTING||s.phase==Phase.RECOVERING||
      (s.phase==Phase.SUPPORT&&AWAITING_REASONS.contains(s.reason));
  }
  /** Conservative observed duration only. Never infer elapsed powered-off time
   * from wall time, abandon an in-flight commit or start a competing install. */
  public Snapshot observePending(String planId,int sessionId,long boot,long elapsed,long budgetMillis)throws IOException {
    require(boot>=0&&elapsed>=0&&budgetMillis>0,"Invalid monotonic observation");
    return transact(s->{
      if((s.phase!=Phase.COMMITTING&&s.phase!=Phase.RECOVERING)||s.plan==null||!s.plan.id.equals(planId)||s.session!=sessionId)return;
      if(s.observedBoot>boot||(s.observedBoot==boot&&s.observedElapsed>elapsed)) {
        s.phase=Phase.SUPPORT;s.reason="install_clock_invalid";return;
      }
      // A previously observed session still present after reboot has been
      // pending throughout this boot. Count current uptime, never off-time or
      // the unknown tail of the previous boot. This avoids reboot starvation.
      long delta=s.observedBoot==boot?elapsed-s.observedElapsed:(s.observedBoot>=0?elapsed:0);
      s.pendingMillis=delta>Long.MAX_VALUE-s.pendingMillis?Long.MAX_VALUE:s.pendingMillis+delta;
      s.observedBoot=boot;s.observedElapsed=elapsed;
      if(s.pendingMillis>=budgetMillis){s.phase=Phase.SUPPORT;s.reason="install_timeout";}
    });
  }
  public Snapshot observeOutcomeUnknown(String planId,int sessionId,long boot,long elapsed)throws IOException {
    return observeOutcomeUnknown(planId,sessionId,boot,elapsed,OUTCOME_UNKNOWN_WAIT_MS);
  }
  /** Counts observed uptime, as observePending does, while a gone session has
   * no report, and releases the plan once waitMillis has passed. A clock that
   * runs backwards restarts the wait rather than shortening it. */
  public Snapshot observeOutcomeUnknown(String planId,int sessionId,long boot,long elapsed,long waitMillis)throws IOException {
    require(boot>=0&&elapsed>=0&&waitMillis>0,"Invalid monotonic observation");
    return transact(s->{
      if(s.phase!=Phase.SUPPORT||!OUTCOME_UNKNOWN.equals(s.reason)||s.plan==null||!s.plan.id.equals(planId)||s.session!=sessionId)return;
      boolean regressed=s.observedBoot>boot||(s.observedBoot==boot&&s.observedElapsed>elapsed);
      long delta=regressed?0:s.observedBoot==boot?elapsed-s.observedElapsed:(s.observedBoot>=0?elapsed:0);
      if(regressed)s.pendingMillis=0;
      s.pendingMillis=delta>Long.MAX_VALUE-s.pendingMillis?Long.MAX_VALUE:s.pendingMillis+delta;
      s.observedBoot=boot;s.observedElapsed=elapsed;
      if(s.pendingMillis>=waitMillis)release(s);
    });
  }
  private static void resetPending(State s){s.pendingMillis=0;s.observedBoot=-1;s.observedElapsed=-1;}
  /** Lets the plan be admitted again, unless the same candidate has spent its
   * retry budget; quarantine and the channel generation stay. */
  private static void release(State s) throws IOException {
    String candidate=s.plan.candidate.digest;
    s.releases=candidate.equals(s.releasedDigest)?s.releases+1:1;s.releasedDigest=candidate;s.reported=null;resetPending(s);
    if(s.releases>=MAX_INSTALL_ATTEMPTS_PER_CANDIDATE){s.phase=Phase.QUARANTINED;quarantine(s,false);s.reason=RETRY_BUDGET_SPENT;return;}
    s.phase=Phase.IDLE;s.plan=null;s.session=-1;s.reason=INSTALL_RELEASED;
  }
  /** Callers capture this snapshot before collecting health evidence. Both
   * verdicts compare it under the mutation lock; even a channel change or a
   * competing verdict invalidates an in-flight observation. This is a race
   * fence, not evidence that renderer/persistence probation has passed. */
  private static void requireHealthObservation(State current, Snapshot observed) throws IOException {
    require(observed!=null && observed.plan!=null && current.revision==observed.revision
      && current.generation==observed.channelGeneration && current.phase==observed.phase
      && current.channel.equals(observed.channel) && samePlan(current.plan,observed.plan),
      "Stale health observation");
  }
  /** Capture observed BEFORE collecting this sample. Persisted timing is fenced
   * by the same revision/plan/channel lock as verdicts. No phase transition. */
  public Snapshot observeProbation(Snapshot observed,Identity installed,ProbationPolicy policy,ProbationSample sample)throws IOException {
    Objects.requireNonNull(policy);Objects.requireNonNull(sample);
    return transact(s->{
      requireHealthObservation(s,observed);
      require(s.phase==Phase.PROBATION||s.phase==Phase.RECOVERY_PROBATION,"No update probation");
      require((s.phase==Phase.RECOVERY_PROBATION?s.plan.recovery:s.plan.candidate).matches(installed),"Probation belongs to different code");
      ProbationWindow old=s.probation;
      if(old!=null)require(sample.boot>old.last.boot||(sample.boot==old.last.boot&&sample.elapsed>old.last.elapsed),"Probation clock regressed or sample repeated");
      long ready=0,failure=0;
      if(old!=null&&policy.same(old.policy)&&sample.sameLifetime(old.last)) {
        long delta=sample.elapsed-old.last.elapsed;
        // Explicit native suspension pauses timers, but never counts the gap.
        // Unknown or missed sampling cannot establish continuous readiness.
        if(old.last.kind==ProbationKind.PAUSED||delta<=policy.maxGapMillis) {
          ready=old.readyMillis;failure=old.failureMillis;
          if(sample.kind==old.last.kind&&sample.kind==ProbationKind.READY&&delta<=policy.maxGapMillis)ready=Math.min(policy.readyMillis,ready+delta);
          if(sample.kind==old.last.kind&&sample.kind==ProbationKind.LOCAL_FAILURE&&delta<=policy.maxGapMillis)failure=Math.min(policy.failureMillis,failure+delta);
        }
      }
      if(sample.kind==ProbationKind.READY)failure=0;
      if(sample.kind==ProbationKind.LOCAL_FAILURE)ready=0;
      if(sample.kind==ProbationKind.UNKNOWN){ready=0;failure=0;}
      s.probation=new ProbationWindow(policy,sample,ready,failure);
    });
  }
  public Snapshot installedHealthy(Snapshot observed, Identity installed) throws IOException {
    return transact(s->{ requireHealthObservation(s,observed); require(s.phase==Phase.PROBATION || s.phase==Phase.RECOVERY_PROBATION,"No update probation");
      boolean recovery=s.phase==Phase.RECOVERY_PROBATION;
      require((recovery?s.plan.recovery:s.plan.candidate).matches(installed),"Health belongs to different code"); s.phase=recovery?Phase.RECOVERED:Phase.HEALTHY; s.reason=""; });
  }
  public Snapshot localHealthFailed(Snapshot observed, Identity installed) throws IOException {
    return transact(s->{ requireHealthObservation(s,observed); require(s.phase==Phase.PROBATION || s.phase==Phase.HEALTHY || s.phase==Phase.RECOVERY_PROBATION,"No candidate health observation");
      require((s.phase==Phase.RECOVERY_PROBATION?s.plan.recovery:s.plan.candidate).matches(installed),"Failure belongs to different code");
      quarantine(s,s.phase==Phase.RECOVERY_PROBATION); s.phase=s.attempts==0?Phase.RECOVERY_READY:Phase.SUPPORT; s.reason="local_health_failed"; });
  }
  public Snapshot recovering(String planId, int sessionId) throws IOException {
    return transact(s->{ requirePlan(s,planId); require(s.phase==Phase.RECOVERY_READY && s.attempts==0,"Recovery already attempted or not ready");
      require(sessionId>=0,"Invalid recovery session"); resetPending(s);s.session=sessionId; s.attempts=1; s.phase=Phase.RECOVERING; });
  }
  public Snapshot installerBlocked(String planId, int sessionId, String reason) throws IOException {
    if (!Arrays.asList("user_action_required","policy_blocked","verification_failed").contains(reason)) throw new IllegalArgumentException("Unknown installer reason");
    return transact(s->{ requirePlan(s,planId); require(s.session==sessionId && (s.phase==Phase.COMMITTING || s.phase==Phase.RECOVERING),"Stale installer callback");
      s.phase=Phase.SUPPORT; s.reason=reason; });
  }
  private static boolean active(Phase phase) { return phase==Phase.STAGING || phase==Phase.VERIFIED || phase==Phase.COMMITTING || phase==Phase.PROBATION || phase==Phase.RECOVERY_READY || phase==Phase.RECOVERING || phase==Phase.RECOVERY_PROBATION || phase==Phase.SUPPORT; }
  private static void quarantine(State s,boolean recovery) throws IOException {
    Set<String> failed=new HashSet<>();failed.add(s.plan.candidate.digest);if(recovery)failed.add(s.plan.recovery.digest);
    failed.removeAll(s.quarantine);require(s.quarantine.size()+failed.size()<=4096,"Quarantine capacity exceeded");s.quarantine.addAll(failed);
  }
  private static void requirePlan(State s,String id) throws IOException { require(s.plan!=null && s.plan.id.equals(id),"Wrong update transaction"); }
  private static void require(boolean value,String message) throws IOException { if(!value)throw new IOException(message); }
  private static long increment(long value) throws IOException { require(value<Long.MAX_VALUE,"Journal counter exhausted");return value+1; }
  /** The transition alone: a new state from the loaded one, with no storage I/O.
   * A refused mutation throws and leaves the loaded state untouched. The only
   * callback a mutation may run is the caller's admission check. */
  private static State step(State current,Mutation mutation) throws IOException {
    State next=current.copy();mutation.apply(next);
    if(next.phase!=current.phase)next.probation=null;
    next.revision=increment(next.revision);return next;
  }
  private Snapshot transact(Mutation mutation) throws IOException { return transact(mutation,null); }
  /** Persists the step, then runs the platform handoff under the same lock. */
  private Snapshot transact(Mutation mutation,CommitAction commit) throws IOException {
    return locked(current->{
      State next=step(current,mutation);store.publish(encode(next));
      if(commit!=null)try{commit.commit();}catch(IOException|RuntimeException failure){throw new HandoffFailed(failure);}
      return new Snapshot(next);
    });
  }
  private <T> T locked(Locked<T> body) throws IOException { return store.exclusive(()->body.apply(decode(store.read()))); }
  private static State decode(byte[] envelope) throws IOException {
    if(envelope==null)return new State();
    require(envelope.length>32 && envelope.length<=MAX_BYTES,"Truncated updater journal");
    byte[] body=Arrays.copyOf(envelope,envelope.length-32);
    require(MessageDigest.isEqual(hash(body),Arrays.copyOfRange(envelope,body.length,envelope.length)),"Corrupt updater journal");
    try(DataInputStream in=new DataInputStream(new ByteArrayInputStream(body))) {
      require(in.readInt()==MAGIC,"Unsupported updater journal");int version=in.readInt();require(version>=1&&version<=VERSION,"Unsupported updater journal"); State s=new State();
      s.revision=in.readLong();s.generation=in.readLong();require(s.revision>=0 && s.generation>=0,"Invalid journal counters");
      s.channel=in.readUTF();require(s.channel.equals("stable")||s.channel.equals("beta"),"Invalid persisted channel");
      s.phase=Phase.valueOf(in.readUTF());s.reason=in.readUTF();s.session=in.readInt();s.attempts=in.readInt();
      require(s.session>=-1 && s.attempts>=0 && s.attempts<=1,"Invalid journal state");
      if(in.readBoolean())s.plan=new Plan(in.readUTF(),in.readUTF(),in.readUTF(),identity(in),identity(in),identity(in));
      int count=in.readInt();require(count>=0&&count<=4096,"Invalid quarantine size");
      for(int i=0;i<count;i++) {String digest=in.readUTF();require(digest.matches("[a-f0-9]{64}")&&s.quarantine.add(digest),"Invalid quarantine entry");}
      if(version>=2) {
        s.pendingMillis=in.readLong();s.observedBoot=in.readLong();s.observedElapsed=in.readLong();
        require(s.pendingMillis>=0&&s.observedBoot>=-1&&s.observedElapsed>=-1&&(s.observedBoot==-1)==(s.observedElapsed==-1),"Invalid pending clock");
      }
      if(version>=4&&in.readBoolean()) {
        ProbationPolicy policy=new ProbationPolicy(in.readUTF(),in.readLong(),in.readLong(),in.readLong());
        ProbationSample sample=new ProbationSample(in.readLong(),in.readLong(),in.readUTF(),in.readUTF(),ProbationKind.valueOf(in.readUTF()));
        long ready=in.readLong(),failure=in.readLong();
        require((s.phase==Phase.PROBATION||s.phase==Phase.RECOVERY_PROBATION)&&ready>=0&&ready<=policy.readyMillis&&failure>=0&&failure<=policy.failureMillis&&!(ready>0&&failure>0),"Invalid probation timing");
        require((sample.kind!=ProbationKind.READY||failure==0)&&(sample.kind!=ProbationKind.LOCAL_FAILURE||ready==0)&&(sample.kind!=ProbationKind.UNKNOWN||(ready==0&&failure==0)),"Inconsistent probation timing");
        require((ready==0&&failure==0)||(!sample.process.equals("none")&&!sample.runtime.equals("none")),"Probation timing without lifetime");
        s.probation=new ProbationWindow(policy,sample,ready,failure);
      }
      if(version>=5) {
        String reported=in.readUTF();s.reported=reported.isEmpty()?null:InstallerFailure.valueOf(reported);
        s.releasedDigest=in.readUTF();s.releases=in.readInt();
        require((s.reported==null||s.plan!=null)&&s.releases>=0&&(s.releasedDigest.isEmpty()?s.releases==0:s.releasedDigest.matches("[a-f0-9]{64}")&&s.releases>0),"Invalid install release record");
      }
      require(in.available()==0 && (s.phase==Phase.IDLE || s.plan!=null),"Invalid journal structure");
      return s;
    } catch(IllegalArgumentException e) { throw new IOException("Invalid updater journal value",e); }
  }
  private static byte[] encode(State s) throws IOException {
    ByteArrayOutputStream bytes=new ByteArrayOutputStream();
    // Version 5 adds only the install report and release record. While they
    // hold their defaults the journal is written as version 4, which an older
    // updater still reads; nothing is lost, since decode restores the defaults.
    boolean installRecord=s.reported!=null||!s.releasedDigest.isEmpty()||s.releases!=0;
    try(DataOutputStream out=new DataOutputStream(bytes)) {
      out.writeInt(MAGIC);out.writeInt(installRecord?VERSION:4);out.writeLong(s.revision);out.writeLong(s.generation);out.writeUTF(s.channel);out.writeUTF(s.phase.name());out.writeUTF(s.reason);out.writeInt(s.session);out.writeInt(s.attempts);
      out.writeBoolean(s.plan!=null);
      if(s.plan!=null){out.writeUTF(s.plan.id);out.writeUTF(s.plan.channel);out.writeUTF(s.plan.distribution);identity(out,s.plan.baseline);identity(out,s.plan.candidate);identity(out,s.plan.recovery);}
      out.writeInt(s.quarantine.size());for(String digest:s.quarantine)out.writeUTF(digest);
      out.writeLong(s.pendingMillis);out.writeLong(s.observedBoot);out.writeLong(s.observedElapsed);
      out.writeBoolean(s.probation!=null);
      if(s.probation!=null){ProbationWindow w=s.probation;out.writeUTF(w.policy.id);out.writeLong(w.policy.readyMillis);out.writeLong(w.policy.failureMillis);out.writeLong(w.policy.maxGapMillis);out.writeLong(w.last.boot);out.writeLong(w.last.elapsed);out.writeUTF(w.last.process);out.writeUTF(w.last.runtime);out.writeUTF(w.last.kind.name());out.writeLong(w.readyMillis);out.writeLong(w.failureMillis);}
      if(installRecord){out.writeUTF(s.reported==null?"":s.reported.name());out.writeUTF(s.releasedDigest);out.writeInt(s.releases);}
    }
    byte[] body=bytes.toByteArray();require(body.length+32<=MAX_BYTES,"Journal exceeds limit");
    byte[] envelope=Arrays.copyOf(body,body.length+32);System.arraycopy(hash(body),0,envelope,body.length,32);return envelope;
  }
  /** Fsync, then same-filesystem rename, under an OS file lock. */
  private static final class FileStore implements Store {
    private final Path directory;
    private final Durability durability;
    private final Faults faults;
    FileStore(Path directory,Durability durability,Faults faults) throws IOException {
      this.directory=directory.toAbsolutePath().normalize(); this.durability=durability; this.faults=faults;
      if (!Files.exists(this.directory,LinkOption.NOFOLLOW_LINKS)) Files.createDirectory(this.directory);
      if (!Files.isDirectory(this.directory,LinkOption.NOFOLLOW_LINKS)) throw new IOException("Invalid updater storage");
    }
    @Override public <T> T exclusive(Exclusive<T> body) throws IOException {
      // Multiple Android components can open distinct instances in one process.
      // FileLock alone throws on overlapping JVM locks instead of waiting.
      synchronized(UpdateJournal.class) {
      try(FileChannel lockChannel=FileChannel.open(directory.resolve("lock"),StandardOpenOption.CREATE,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS);
          FileLock lock=lockChannel.lock()) {
        require(lock.isValid(),"Updater storage lock unavailable");
        return body.run();
      }
      }
    }
    @Override public byte[] read() throws IOException {
      Path file=directory.resolve("journal");
      if(!Files.exists(file,LinkOption.NOFOLLOW_LINKS)) {
        require(!Files.exists(directory.resolve("initialized"),LinkOption.NOFOLLOW_LINKS),"Previously initialized updater journal is missing");
        return null;
      }
      require(Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS) && Files.size(file)<=MAX_BYTES,"Invalid updater journal");
      byte[] envelope=Files.readAllBytes(file);markInitialized();return envelope;
    }
    /** The marker follows the first published journal. A failed or full first
     * write leaves no marker, so the device still reads as new; a journal lost
     * after the marker reads as lost. Between the rename and the marker, a loss
     * would read as new; load repairs a missing marker on the next read. */
    @Override public void publish(byte[] envelope) throws IOException {
      replace("journal",envelope,"");
      markInitialized();faults.boundary("published");
    }
    private void markInitialized() throws IOException {
      Path marker=directory.resolve("initialized");
      if(Files.exists(marker,LinkOption.NOFOLLOW_LINKS)) {
        require(Files.isRegularFile(marker,LinkOption.NOFOLLOW_LINKS)&&Files.size(marker)==1&&Files.readAllBytes(marker)[0]==1,"Invalid journal initialization marker");return;
      }
      replace("initialized",new byte[]{1},"marker-");
    }
    /** Fsync a temporary file, then rename it over name, so name is never partial. */
    private void replace(String name,byte[] value,String boundary) throws IOException {
      Path temporary=directory.resolve(name+".next");
      try(FileChannel file=FileChannel.open(temporary,StandardOpenOption.CREATE,StandardOpenOption.TRUNCATE_EXISTING,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS)) {
        java.nio.ByteBuffer buffer=java.nio.ByteBuffer.wrap(value);while(buffer.hasRemaining())file.write(buffer);
        faults.boundary(boundary+"before-sync");file.force(true);
      }
      faults.boundary(boundary+"before-rename");Files.move(temporary,directory.resolve(name),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
      durability.syncDirectory(directory);
    }
  }
  private static byte[] hash(byte[] bytes) { try{return MessageDigest.getInstance("SHA-256").digest(bytes);}catch(Exception e){throw new IllegalStateException(e);} }
  private static Identity identity(DataInputStream in)throws IOException{return new Identity(in.readLong(),in.readUTF());}
  private static void identity(DataOutputStream out,Identity id)throws IOException{out.writeLong(id.code);out.writeUTF(id.digest);}
}
