package ai.eliza.plugins.agent.updater;
import android.app.job.*;
import android.os.Handler;
import android.os.Looper;
import java.util.concurrent.*;

/** Local package readback works offline. It never starts an installation. */
public abstract class ReconciliationJobService extends JobService {
 protected abstract void reconcile(JobRunRegistry.Cancellation cancellation)throws Exception;
 private final ThreadPoolExecutor workers=new ThreadPoolExecutor(2,2,0,TimeUnit.MILLISECONDS,
   new ArrayBlockingQueue<>(4),r->new Thread(r,"UpdateReconcile"),new ThreadPoolExecutor.AbortPolicy());
 private final Handler lifecycle=new Handler(Looper.getMainLooper());
 private final JobRunRegistry runs=new JobRunRegistry(workers,action->lifecycle.post(action));
 @Override public boolean onStartJob(JobParameters parameters) {
  workers.purge();
  runs.start(parameters.getJobId(),cancellation->{
   if(cancellation.isCancelled())return true;
   try{reconcile(cancellation);return false;}
   catch(Exception failure){android.util.Log.e("ElizaUpdater","Reconciliation deferred: "+failure.getClass().getSimpleName());return true;}
  },retry->jobFinished(parameters,retry));
  return true;
 }
 @Override public boolean onStopJob(JobParameters parameters) {
  runs.stop(parameters.getJobId());workers.purge();return true;
 }
 @Override public void onDestroy() {
  runs.close();workers.shutdownNow();super.onDestroy();
 }
}
