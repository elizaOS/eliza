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
   InstallerResultReceiver.reconcile(app,target,action,journal,callback);
   check(UpdateJournal.Phase.QUARANTINED==journal.read().phase,"Missing session was not quarantined");
  } finally {try{installer.abandonSession(session);}catch(Exception ignored){}}
 }
}
