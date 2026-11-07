package ai.eliza.plugins.agent.updater;

import java.io.IOException;

/** Platform readback of an install the journal is waiting on. PackageInstaller
 * sits behind Platform, so the decisions here run on the JVM. Installed APK
 * identity and our own live session win over callback delivery. */
public final class InstallReadback {
  /** Our own session for the target package, as the platform lists it. UNKNOWN
   * means the platform cannot say whether it was committed (before API 29). */
  public enum Session { GONE, UNCOMMITTED, COMMITTED, UNKNOWN }
  public interface Platform {
    UpdateJournal.Identity installed() throws Exception;
    Session session(int sessionId) throws Exception;
    void abandon(int sessionId) throws Exception;
    long bootCount() throws Exception;
    long elapsedRealtime();
  }
  /** Owner-overridable default: the observed uptime a candidate session must
   * stay listed and uncommitted before it is abandoned. On API 31 and later
   * Session.commit returns once the session is sealed, and SessionInfo
   * reports it committed only after the platform has streamed and verified the
   * APK, which can take seconds; an uncommitted reading alone does not prove
   * the handoff failed. One periodic reconciliation job interval. */
  public static final long UNCOMMITTED_ABANDON_WAIT_MS=UpdateJournal.OUTCOME_UNKNOWN_WAIT_MS;
  private InstallReadback() {}

  /** Safe after process death, a throw from Session.commit or a missing
   * callback. Only a session the platform has reported uncommitted for long
   * enough is abandoned; a committed or unknown one is left to install or
   * expire. Hosts run this periodically while
   * UpdateJournal.awaitingInstaller holds (PackageInstallCoordinator.reconcilePending):
   * it alone counts the observed time that times out a stalled session and
   * releases a gone session with no report, and until then the journal admits
   * no other plan. An uncommitted candidate session is timed out no sooner than
   * UNCOMMITTED_ABANDON_WAIT_MS, even under a shorter host budget. */
  public static UpdateJournal.Snapshot reconcile(UpdateJournal journal,Platform platform,long observationBudgetMs)throws Exception {
    UpdateJournal.Snapshot state=journal.read();
    if(!UpdateJournal.awaitingInstaller(state))return state;
    String plan=state.plan.id;int session=state.sessionId;
    if(abandonUncommitted(journal,platform,plan,session))
      return journal.reconcileInstallerResult(plan,session,platform.installed(),false,null,UpdateJournal.InstallerFailure.RETRYABLE);
    Session listed=platform.session(session);boolean pending=listed!=Session.GONE;
    UpdateJournal.Snapshot reconciled=journal.reconcile(plan,session,platform.installed(),pending);
    if(pending&&(reconciled.phase==UpdateJournal.Phase.COMMITTING||reconciled.phase==UpdateJournal.Phase.RECOVERING)) {
      // A timed-out uncommitted candidate is abandoned next, so a sealed one
      // still being verified gets the full wait whatever the host budget is.
      long budget=reconciled.phase==UpdateJournal.Phase.COMMITTING&&listed==Session.UNCOMMITTED?Math.max(observationBudgetMs,UNCOMMITTED_ABANDON_WAIT_MS):observationBudgetMs;
      return journal.observePending(plan,session,platform.bootCount(),platform.elapsedRealtime(),budget);
    }
    if(!pending&&reconciled.phase==UpdateJournal.Phase.SUPPORT&&UpdateJournal.OUTCOME_UNKNOWN.equals(reconciled.reason))
      return journal.observeOutcomeUnknown(plan,session,platform.bootCount(),platform.elapsedRealtime());
    return reconciled;
  }

  /** Whether the journal has waited long enough that an uncommitted reading
   * means the session was refused or never handed off. A sealed session can
   * read uncommitted right after Session.commit returns, so a candidate waits
   * UNCOMMITTED_ABANDON_WAIT_MS of observed uptime, and a recovery, attempted
   * only once, is never abandoned before the host's install timeout. A session
   * in support has hit that timeout (reconcile holds an uncommitted candidate
   * to at least UNCOMMITTED_ABANDON_WAIT_MS of it) or had a platform callback;
   * a clock fault proves no elapsed time, so it is kept. */
  static boolean mayAbandon(UpdateJournal.Snapshot state) {
    switch(state.phase) {
      case COMMITTING: return state.pendingMillis>=UNCOMMITTED_ABANDON_WAIT_MS;
      case SUPPORT: return !"install_clock_invalid".equals(state.reason);
      default: return false;
    }
  }

  /** The decision and the abandon run under one journal lock, which the
   * coordinator also holds while it persists the handoff and calls commit. */
  static boolean abandonUncommitted(UpdateJournal journal,Platform platform,String plan,int session)throws IOException {
    boolean[] abandoned={false};
    journal.withLockedSnapshot(state->{
      if(!UpdateJournal.awaitingInstaller(state)||state.plan==null||!state.plan.id.equals(plan)||state.sessionId!=session)return;
      if(!mayAbandon(state))return;
      try {
        if(platform.session(session)!=Session.UNCOMMITTED)return;
        platform.abandon(session);
      } catch(IOException failure){throw failure;}
      catch(Exception failure){throw new IOException("Install session readback failed",failure);}
      abandoned[0]=true;
    });
    return abandoned[0];
  }
}
