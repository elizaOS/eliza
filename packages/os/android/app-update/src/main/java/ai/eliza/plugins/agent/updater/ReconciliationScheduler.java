package ai.eliza.plugins.agent.updater;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;

/** Local installer reconciliation is separate from network release discovery.
 * No charging, network or formal device-idle constraint may block readback. */
public final class ReconciliationScheduler {
 private ReconciliationScheduler() {}
 public static synchronized void ensurePeriodic(Context context,Class<? extends android.app.job.JobService> service,int periodicId) {
  JobScheduler scheduler=context.getSystemService(JobScheduler.class);
  if(scheduler==null)throw new IllegalStateException("JobScheduler unavailable");
  if(scheduler.getPendingJob(periodicId)!=null)return;
  schedule(scheduler,new JobInfo.Builder(periodicId,new ComponentName(context,service))
    .setPersisted(true).setPeriodic(15*60*1000L).setBackoffCriteria(30000,JobInfo.BACKOFF_POLICY_EXPONENTIAL).build());
 }
 public static synchronized void requestReconcile(Context context,Class<? extends android.app.job.JobService> service,int periodicId,int immediateId) {
  if(periodicId==immediateId)throw new IllegalArgumentException("Distinct reconciliation job IDs required");
  ensurePeriodic(context,service,periodicId);
  JobScheduler scheduler=context.getSystemService(JobScheduler.class);
  // Repeated boot/unlock triggers must not push existing work into the future.
  if(scheduler.getPendingJob(immediateId)!=null)return;
  schedule(scheduler,new JobInfo.Builder(immediateId,new ComponentName(context,service))
    .setPersisted(true).setMinimumLatency(1000).setOverrideDeadline(30000)
    .setBackoffCriteria(30000,JobInfo.BACKOFF_POLICY_EXPONENTIAL).build());
 }
 private static void schedule(JobScheduler scheduler,JobInfo job) {
  if(scheduler.schedule(job)!=JobScheduler.RESULT_SUCCESS)throw new IllegalStateException("Reconciliation scheduling failed");
 }
}
