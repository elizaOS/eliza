// spec/os/signIn/credential.md, "A daily job kept across reboots gives every spent duty one more try, refreshes a lease a day old and renews a key that is due"
package ai.eliza.plugins.signin;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.PersistableBundle;
import java.util.Arrays;
import java.util.List;

public final class DeviceKeyJob extends JobService {
  private static final String DAILY = "daily", RENEWAL = "renewal", ORIGINS = "apiOrigins", AT = "at";
  private static final long FLEX_MS = 6 * 60 * CredentialPolicy.MILLIS_PER_MINUTE;
  private static PersistableBundle plan;

  static synchronized void schedule(Context context, SignInRegistration registration) {
    PersistableBundle wanted = new PersistableBundle();
    wanted.putInt(DAILY, registration.keyJobs.daily());
    wanted.putInt(RENEWAL, registration.keyJobs.renewal());
    wanted.putStringArray(ORIGINS, registration.environments().stream().map(environment -> environment.apiOrigin).toArray(String[]::new));
    plan = wanted;
    JobScheduler scheduler = scheduler(context);
    JobInfo pending = scheduler.getPendingJob(registration.keyJobs.daily());
    if (pending != null && samePlan(pending.getExtras(), wanted)) return;
    submit(scheduler, job(context, registration.keyJobs.daily(), wanted).setPeriodic(CredentialPolicy.MILLIS_PER_DAY, FLEX_MS).build());
  }

  static synchronized void renewAt(Context context, long at) {
    long now = System.currentTimeMillis();
    if (plan == null || at <= now) return;
    JobScheduler scheduler = scheduler(context);
    JobInfo pending = scheduler.getPendingJob(plan.getInt(RENEWAL));
    if (pending != null && samePlan(pending.getExtras(), plan) && pending.getExtras().getLong(AT) > now && pending.getExtras().getLong(AT) <= at) return;
    PersistableBundle extras = new PersistableBundle(plan);
    extras.putLong(AT, at);
    submit(scheduler, job(context, plan.getInt(RENEWAL), extras).setMinimumLatency(at - now).build());
  }

  private static boolean samePlan(PersistableBundle held, PersistableBundle wanted) {
    return held.getInt(DAILY) == wanted.getInt(DAILY) && held.getInt(RENEWAL) == wanted.getInt(RENEWAL)
      && Arrays.equals(held.getStringArray(ORIGINS), wanted.getStringArray(ORIGINS));
  }

  private static JobScheduler scheduler(Context context) {
    JobScheduler scheduler = context.getSystemService(JobScheduler.class);
    if (scheduler == null) throw new IllegalStateException("JobScheduler unavailable");
    return scheduler;
  }

  private static JobInfo.Builder job(Context context, int id, PersistableBundle extras) {
    return new JobInfo.Builder(id, new ComponentName(context, DeviceKeyJob.class)).setPersisted(true)
      .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setExtras(extras);
  }

  private static void submit(JobScheduler scheduler, JobInfo job) {
    if (scheduler.schedule(job) != JobScheduler.RESULT_SUCCESS) throw new IllegalStateException("The device key job could not be scheduled");
  }

  @Override public boolean onStartJob(JobParameters parameters) {
    PersistableBundle extras = parameters.getExtras();
    synchronized (DeviceKeyJob.class) {
      if (plan == null) {
        plan = new PersistableBundle(extras);
        plan.remove(AT);
      }
    }
    String[] origins = extras.getStringArray(ORIGINS);
    DeviceCustody.runDailyJob(getApplicationContext(), origins == null ? List.of() : List.of(origins), () -> jobFinished(parameters, false));
    return true;
  }

  @Override public boolean onStopJob(JobParameters parameters) { return true; }
}
