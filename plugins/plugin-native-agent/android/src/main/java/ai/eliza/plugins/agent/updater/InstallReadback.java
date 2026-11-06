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
  private InstallReadback() {}

  /** Safe after process death, a throw from Session.commit or a missing
   * callback. Only a session the platform reports as never committed is
   * abandoned; a committed or unknown one is left to install or expire. */
  public static UpdateJournal.Snapshot reconcile(UpdateJournal journal,Platform platform,long observationBudgetMs)throws Exception {
    UpdateJournal.Snapshot state=journal.read();
    if(!UpdateJournal.awaitingInstaller(state))return state;
    String plan=state.plan.id;int session=state.sessionId;
    if(abandonUncommitted(journal,platform,plan,session))
      return journal.reconcileInstallerResult(plan,session,platform.installed(),false,null,UpdateJournal.InstallerFailure.RETRYABLE);
    boolean pending=platform.session(session)!=Session.GONE;
    UpdateJournal.Snapshot reconciled=journal.reconcile(plan,session,platform.installed(),pending);
    if(pending&&(reconciled.phase==UpdateJournal.Phase.COMMITTING||reconciled.phase==UpdateJournal.Phase.RECOVERING))
      return journal.observePending(plan,session,platform.bootCount(),platform.elapsedRealtime(),observationBudgetMs);
    if(!pending&&reconciled.phase==UpdateJournal.Phase.SUPPORT&&UpdateJournal.OUTCOME_UNKNOWN.equals(reconciled.reason))
      return journal.observeOutcomeUnknown(plan,session,platform.bootCount(),platform.elapsedRealtime());
    return reconciled;
  }

  /** The coordinator persists COMMITTING and calls Session.commit under one
   * journal lock, so a session still uncommitted while this lock is held was
   * refused or never handed off, and nothing will commit it later. */
  static boolean abandonUncommitted(UpdateJournal journal,Platform platform,String plan,int session)throws IOException {
    boolean[] abandoned={false};
    journal.withLockedSnapshot(state->{
      if(!UpdateJournal.awaitingInstaller(state)||state.plan==null||!state.plan.id.equals(plan)||state.sessionId!=session)return;
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
