package ai.eliza.plugins.agent.contract;
import android.content.*;
import ai.eliza.plugins.agent.updater.*;
/** Real framework session readback; host supplies a fresh journal and installed baseline plan. */
public final class InstallerResultContract {
 private InstallerResultContract() {}
 private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
 public static void run(Context app,UpdateJournal journal,UpdateJournal.Plan plan,String target,String action)throws Exception {
  journal.begin(plan,plan.baseline,0);
  android.content.pm.PackageInstaller installer=app.getPackageManager().getPackageInstaller();
  android.content.pm.PackageInstaller.SessionParams params=new android.content.pm.PackageInstaller.SessionParams(android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL);
  params.setAppPackageName(target);
  int session=installer.createSession(params);
  try {
   journal.committing(plan.id,session,0);
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
   installer.abandonSession(session);
   long deadline=android.os.SystemClock.elapsedRealtime()+10000;
   while(PackageInstallCoordinator.hasPendingSession(app,target,session)&&android.os.SystemClock.elapsedRealtime()<deadline)Thread.sleep(100);
   check(!PackageInstallCoordinator.hasPendingSession(app,target,session),"Session was not abandoned");
   // A gone session quarantines only on a reported candidate fault.
   InstallerResultReceiver.reconcile(app,target,action,journal,callback.putExtra(android.content.pm.PackageInstaller.EXTRA_STATUS,1));
   check("install_outcome_unknown".equals(journal.read().reason)&&journal.read().quarantine.isEmpty(),"Unreported failure quarantined the candidate");
   InstallerResultReceiver.reconcile(app,target,action,journal,callback.putExtra(android.content.pm.PackageInstaller.EXTRA_STATUS,android.content.pm.PackageInstaller.STATUS_FAILURE_INVALID));
   check(UpdateJournal.Phase.QUARANTINED==journal.read().phase&&journal.read().quarantine.contains(plan.candidate.digest),"Rejected candidate was not quarantined");
   for(int status:new int[]{android.content.pm.PackageInstaller.STATUS_FAILURE_STORAGE,android.content.pm.PackageInstaller.STATUS_FAILURE_ABORTED,android.content.pm.PackageInstaller.STATUS_FAILURE_TIMEOUT})
    check(InstallerResultReceiver.failure(status)==UpdateJournal.InstallerFailure.RETRYABLE,"Transient failure not retryable");
   for(int status:new int[]{android.content.pm.PackageInstaller.STATUS_SUCCESS,android.content.pm.PackageInstaller.STATUS_FAILURE,987654})
    check(InstallerResultReceiver.failure(status)==null,"Status without evidence reported a failure");
  } finally {try{installer.abandonSession(session);}catch(Exception ignored){}}
 }
}
