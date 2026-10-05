package ai.eliza.plugins.agent.updater;
import android.content.*;
import android.content.pm.PackageInstaller;
import java.util.concurrent.Executor;
/** Non-exported host callback. Framework hints never replace installed/session readback. */
public abstract class InstallerResultReceiver extends BroadcastReceiver {
 protected abstract String targetPackage();
 protected abstract String callbackAction();
 protected abstract UpdateJournal journal(Context context)throws Exception;
 protected abstract Executor callbackExecutor();
 protected void reportFailure(Exception failure){android.util.Log.e("ElizaUpdater","Install result requires durable reconciliation: "+failure.getClass().getSimpleName());}
 @Override public final void onReceive(Context context,Intent intent) {
  PendingResult pending=goAsync();
  java.util.concurrent.atomic.AtomicBoolean finished=new java.util.concurrent.atomic.AtomicBoolean();
  Runnable finish=()->{if(finished.compareAndSet(false,true))pending.finish();};
  try{callbackExecutor().execute(()->{
   try{String action=callbackAction();if(intent==null||!action.equals(intent.getAction()))return;reconcile(context,targetPackage(),action,journal(context),intent);}
   catch(Exception failure){reportFailure(failure);}
   finally{finish.run();}
  });}catch(RuntimeException rejected){try{reportFailure(rejected);}finally{finish.run();}}
 }
 public static void reconcile(Context context,String target,String action,UpdateJournal journal,Intent intent)throws Exception {
  if(target==null||target.isEmpty()||action==null||action.isEmpty())throw new IllegalArgumentException("Explicit target and callback action required");
  if(intent==null||!action.equals(intent.getAction()))return;
  UpdateJournal.Snapshot state=journal.read();
  String transaction=intent.getStringExtra("transaction");int session=intent.getIntExtra("expectedSession",-1);
  // Require the framework session id as well as our immutable callback
  // identity. A missing status is malformed, not a terminal failure.
  if(state.plan==null||!state.plan.id.equals(transaction)||state.sessionId!=session
      ||intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID,-1)!=session
      ||!intent.hasExtra(PackageInstaller.EXTRA_STATUS)||!UpdateJournal.awaitingInstaller(state))return;
  String reportedPackage=intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME);
  if(reportedPackage!=null&&!target.equals(reportedPackage))return;
  int status=intent.getIntExtra(PackageInstaller.EXTRA_STATUS,PackageInstaller.STATUS_FAILURE);
  String blocked=status==PackageInstaller.STATUS_PENDING_USER_ACTION?"user_action_required":
    status==PackageInstaller.STATUS_FAILURE_BLOCKED?"policy_blocked":null;
  // Includes success, all failure codes and unknown future statuses. Never
  // launch EXTRA_INTENT or treat delivery itself as installation evidence.
  boolean pendingSession=PackageInstallCoordinator.hasPendingSession(context,target,session);
  journal.reconcileInstallerResult(transaction,session,PackageInstallCoordinator.installed(context,target),pendingSession,blocked);
 }
}
