package ai.eliza.plugins.agent.contract;
import android.content.*;
import ai.eliza.plugins.agent.updater.*;
/** Real framework session readback; host supplies a fresh journal and installed baseline plan. */
public final class InstallerResultContract {
 /** A plan that is still fresh: these cases are about the install, not commit freshness. */
 private static final UpdateJournal.FreshnessCheck FRESH=(plan,generation)->{};
 private InstallerResultContract() {}
 private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
 public static void run(Context app,UpdateJournal journal,UpdateJournal.Plan plan,String target,String action)throws Exception {
  journal.begin(plan,plan.baseline,0);
  android.content.pm.PackageInstaller installer=app.getPackageManager().getPackageInstaller();
  android.content.pm.PackageInstaller.SessionParams params=new android.content.pm.PackageInstaller.SessionParams(android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL);
  params.setAppPackageName(target);
  int session=installer.createSession(params);
  try {
   journal.committingWithAction(plan.id,session,0,FRESH,()->{});
   Intent callback=new Intent(action)
    .putExtra("transaction",plan.id).putExtra("expectedSession",session)
    .putExtra(android.content.pm.PackageInstaller.EXTRA_SESSION_ID,session)
    .putExtra(android.content.pm.PackageInstaller.EXTRA_PACKAGE_NAME,target)
    .putExtra(android.content.pm.PackageInstaller.EXTRA_STATUS,987654);
   long revision=journal.read().revision;
   InstallerResultReceiver.reconcile(app,target,action,journal,null);check(revision==journal.read().revision,"Null callback changed journal");
   for(Intent wrong:new Intent[]{new Intent(callback).putExtra("transaction","wrong"),new Intent(callback).putExtra("expectedSession",session+1)}){InstallerResultReceiver.reconcile(app,target,action,journal,wrong);check(revision==journal.read().revision,"Wrong immutable identity accepted");}
   Intent malformed=new Intent(callback);malformed.removeExtra(android.content.pm.PackageInstaller.EXTRA_STATUS);
   InstallerResultReceiver.reconcile(app,target,action,journal,malformed);check(revision==journal.read().revision,"Malformed callback changed journal");
   malformed=new Intent(callback).putExtra(android.content.pm.PackageInstaller.EXTRA_SESSION_ID,session+1);
   InstallerResultReceiver.reconcile(app,target,action,journal,malformed);check(revision==journal.read().revision,"Malformed callback changed journal");
   malformed=new Intent(callback).putExtra(android.content.pm.PackageInstaller.EXTRA_PACKAGE_NAME,"unrelated.package");
   InstallerResultReceiver.reconcile(app,target,action,journal,malformed);check(revision==journal.read().revision,"Malformed callback changed journal");
   malformed=new Intent(callback).setAction("unrelated.action");
   InstallerResultReceiver.reconcile(app,target,action,journal,malformed);check(revision==journal.read().revision,"Malformed callback changed journal");
   // Actual framework session remains live. Unknown, success and terminal-looking
   // failure hints must not invent an installed candidate or disappear the session.
   for(int status:new int[]{987654,0,1,3,4,5,6,7,8}) {
    callback.putExtra(android.content.pm.PackageInstaller.EXTRA_STATUS,status);
    InstallerResultReceiver.reconcile(app,target,action,journal,callback);
    check(UpdateJournal.Phase.COMMITTING==journal.read().phase,"Callback hint replaced actual session evidence");
   }
   // The INVALID and INCOMPATIBLE hints above were kept, not dropped.
   check(journal.read().reportedFailure==UpdateJournal.InstallerFailure.CANDIDATE_REJECTED&&journal.read().quarantine.isEmpty(),"Live-session rejection was dropped or applied early");
   installer.abandonSession(session);
   long deadline=android.os.SystemClock.elapsedRealtime()+10000;
   while(PackageInstallCoordinator.hasPendingSession(app,target,session)&&android.os.SystemClock.elapsedRealtime()<deadline)Thread.sleep(100);
   check(!PackageInstallCoordinator.hasPendingSession(app,target,session),"Session was not abandoned");
   // Once the session is gone, the kept rejection quarantines even with a
   // callback that reports nothing.
   InstallerResultReceiver.reconcile(app,target,action,journal,callback.putExtra(android.content.pm.PackageInstaller.EXTRA_STATUS,1));
   check(UpdateJournal.Phase.QUARANTINED==journal.read().phase&&journal.read().quarantine.contains(plan.candidate.digest),"Rejected candidate was not quarantined");
   for(int status:new int[]{android.content.pm.PackageInstaller.STATUS_FAILURE_INVALID,android.content.pm.PackageInstaller.STATUS_FAILURE_CONFLICT,android.content.pm.PackageInstaller.STATUS_FAILURE_INCOMPATIBLE})
    check(InstallerResultReceiver.failure(status)==UpdateJournal.InstallerFailure.CANDIDATE_REJECTED,"Candidate fault not reported");
   for(int status:new int[]{android.content.pm.PackageInstaller.STATUS_FAILURE_STORAGE,android.content.pm.PackageInstaller.STATUS_FAILURE_ABORTED,android.content.pm.PackageInstaller.STATUS_FAILURE_TIMEOUT})
    check(InstallerResultReceiver.failure(status)==UpdateJournal.InstallerFailure.RETRYABLE,"Transient failure not retryable");
   for(int status:new int[]{android.content.pm.PackageInstaller.STATUS_SUCCESS,android.content.pm.PackageInstaller.STATUS_FAILURE,987654})
    check(InstallerResultReceiver.failure(status)==null,"Status without evidence reported a failure");
  } finally {try{installer.abandonSession(session);}catch(Exception ignored){}}
 }
 /** A durable COMMITTING record whose session was never committed (process
  * death before Session.commit, or a refused commit) is kept at first, since a
  * sealed session also reads uncommitted while the platform verifies it, then
  * abandoned and released once UNCOMMITTED_ABANDON_WAIT_MS and the install
  * timeout have passed, so a later
  * release can install. Needs API 29 or later. */
 public static void runUncommittedSession(Context app,UpdateJournal journal,UpdateJournal.Plan plan,String target)throws Exception {
  journal.begin(plan,plan.baseline,0);
  android.content.pm.PackageInstaller installer=app.getPackageManager().getPackageInstaller();
  android.content.pm.PackageInstaller.SessionParams params=new android.content.pm.PackageInstaller.SessionParams(android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL);
  params.setAppPackageName(target);
  int session=installer.createSession(params);
  try {
   journal.committingWithAction(plan.id,session,0,FRESH,()->{});
   check(PackageInstallCoordinator.sessionState(app,target,session)==InstallReadback.Session.UNCOMMITTED,"Fresh session not reported uncommitted");
   UpdateJournal.Snapshot kept=PackageInstallCoordinator.reconcilePending(app,target,journal,60000);
   check(kept.phase==UpdateJournal.Phase.COMMITTING&&PackageInstallCoordinator.hasPendingSession(app,target,session),"Uncommitted session was abandoned at once");
   Thread.sleep(20);
   kept=PackageInstallCoordinator.reconcilePending(app,target,journal,1);
   check(kept.phase==UpdateJournal.Phase.COMMITTING&&PackageInstallCoordinator.hasPendingSession(app,target,session),"Uncommitted session timed out before the abandon wait");
   // Stand in for UNCOMMITTED_ABANDON_WAIT_MS of uptime: a later boot whose
   // reading counts that much, so the test need not wait 15 minutes.
   check(journal.observePending(plan.id,session,Integer.MAX_VALUE,InstallReadback.UNCOMMITTED_ABANDON_WAIT_MS,1).reason.equals("install_timeout"),"Uncommitted session did not time out");
   UpdateJournal.Snapshot after=PackageInstallCoordinator.reconcilePending(app,target,journal,1);
   check(!PackageInstallCoordinator.hasPendingSession(app,target,session),"Uncommitted session was kept");
   check(after.phase==UpdateJournal.Phase.IDLE&&UpdateJournal.INSTALL_RELEASED.equals(after.reason)&&after.quarantine.isEmpty(),"Uncommitted session was not released");
   journal.begin(plan,plan.baseline,0);check(journal.read().phase==UpdateJournal.Phase.VERIFIED,"Released plan was not admitted again");
  } finally {try{installer.abandonSession(session);}catch(Exception ignored){}}
 }
}
