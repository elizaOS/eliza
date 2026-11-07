package ai.eliza.plugins.agent.updater;

import android.app.PendingIntent;
import android.app.admin.DevicePolicyManager;
import android.content.*;
import android.content.pm.*;
import android.os.Build;
import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.Locale;

/** Private native install boundary. It has no exported caller or arbitrary URL
 * input. Trusted discovery and safe-activation orchestration sit above it. */
public abstract class PackageInstallCoordinator {
  protected final Context context;
  private final UpdateJournal journal;
  protected final String signer;
  private final boolean testArtifacts;
  private final byte[] candidateRuntime,recoveryRuntime;
  private final String artifactHosts,runtimeAbi,target,distributionKey,callbackAction;
  private final Class<? extends BroadcastReceiver> callbackReceiver;
  private final long observationBudgetMs;
  protected String recoveryAuthorizationId;
  protected long recoverySecurityFloor;
  protected PackageInstallCoordinator(Context context,UpdateJournal journal,String target,String distributionKey,
      Class<? extends BroadcastReceiver> callbackReceiver,String callbackAction,long observationBudgetMs,
      String signer,boolean testArtifacts,boolean allowTestArtifacts,byte[] candidateRuntime,byte[] recoveryRuntime,
      String artifactHosts,String runtimeAbi) throws IOException {
    if(signer==null||!signer.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Production signer must be provisioned");
    if(testArtifacts&&!allowTestArtifacts)throw new IllegalArgumentException("Test APKs forbidden in release supervisor");
    if(target==null||target.isEmpty()||distributionKey==null||distributionKey.isEmpty()||callbackAction==null||callbackAction.isEmpty()||observationBudgetMs<=0)throw new IllegalArgumentException("Explicit host install policy required");
    this.context=context.getApplicationContext();this.journal=java.util.Objects.requireNonNull(journal);
    this.target=target;this.distributionKey=distributionKey;this.callbackReceiver=java.util.Objects.requireNonNull(callbackReceiver);this.callbackAction=callbackAction;this.observationBudgetMs=observationBudgetMs;
    this.signer=signer;this.testArtifacts=testArtifacts;
    this.candidateRuntime=candidateRuntime==null?null:candidateRuntime.clone();this.recoveryRuntime=recoveryRuntime==null?null:recoveryRuntime.clone();this.artifactHosts=artifactHosts;this.runtimeAbi=runtimeAbi;
  }
  /** The host must use authenticated trust material; these hooks cannot replace APK/session checks. */
  protected abstract void verifyPair(UpdateJournal.Plan plan,long generation,byte[] candidate,byte[] recovery)throws Exception;
  protected abstract void verifyRuntime(File file,byte[] runtime,String approvedHosts,String abi)throws Exception;
  protected abstract void verifyRecovery(UpdateJournal.Plan plan,long securityFloor)throws Exception;
  /** Refuses, by throwing, a plan that may no longer install: it reads trusted
   * time now and requires an "eligible" EvaluatePreparedForCommit under
   * commitFreshnessPolicy(now,floor,bounds). It runs under the journal lock, so
   * it must do no network I/O. */
  protected abstract void verifyCommitFreshness(UpdateJournal.Plan plan,long generation,CommitFreshness bounds)throws Exception;
  /** The policy EvaluatePreparedForCommit reads. */
  public static byte[] commitFreshnessPolicy(QualifiedClockAnchor.Interval now,long securityFloor,CommitFreshness bounds)throws org.json.JSONException {
    return new org.json.JSONObject().put("trustedLowerMs",now.lower).put("trustedUpperMs",now.upper).put("securityFloor",securityFloor)
      .put("refreshedAfterLowerMs",bounds.refreshedAfterLowerMs).put("commitByUpperMs",bounds.commitByUpperMs)
      .toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
  }
  /** activationStartedLowerMs is the trusted lower bound read when the activation
   * run began, before it refreshed metadata (CommitFreshness.forActivation). */
  public final int commit(File candidate,File recovery,long generation,long activationStartedLowerMs) throws Exception {
    CommitFreshness bounds=CommitFreshness.forActivation(activationStartedLowerMs);
    UpdateJournal.Snapshot state=journal.read();
    if(state.phase!=UpdateJournal.Phase.VERIFIED||state.plan==null)throw new IOException("No admitted update");
    verifyPreparedArtifacts(candidate,recovery,state.plan,generation);
    if(!state.plan.baseline.matches(installed(context,target)))throw new IOException("Installed package changed");
    UpdateJournal.FreshnessCheck fresh=(plan,current)->{
      try{verifyCommitFreshness(plan,current,bounds);}
      catch(Exception refused){throw new IOException("Commit freshness rejected",refused);}
    };
    return install(candidate,state.plan.candidate,state.plan.id,generation,fresh);
  }
  /** Reusable preparation verification; commit repeats it against current bytes. */
  public final void verifyPreparedArtifacts(File candidate,File recovery,UpdateJournal.Plan plan,long generation)throws Exception {
    verify(candidate,plan.candidate,plan.distribution,candidateRuntime);
    verify(recovery,plan.recovery,plan.distribution,recoveryRuntime);
    if(!testArtifacts) {
      if(candidateRuntime==null||recoveryRuntime==null)throw new IOException("Authenticated runtime expectations missing");
      verifyPair(plan,generation,candidateRuntime.clone(),recoveryRuntime.clone());
    }
  }
  public final int recover(File recovery) throws Exception {
    UpdateJournal.Snapshot state=journal.read();
    if(state.phase!=UpdateJournal.Phase.RECOVERY_READY||state.plan==null)throw new IOException("No authorized recovery");
    if(!testArtifacts) {
      if(!state.plan.id.equals(recoveryAuthorizationId))throw new IOException("Cached recovery authorization required");
      verifyRecovery(state.plan,recoverySecurityFloor);
    }
    verify(recovery,state.plan.recovery,state.plan.distribution,recoveryRuntime);
    if(!state.plan.candidate.matches(installed(context,target)))throw new IOException("Installed candidate changed before recovery");
    return install(recovery,state.plan.recovery,state.plan.id,state.channelGeneration,null);
  }
  /** fresh is null for a recovery, which installs only the authorized recovery. */
  private int install(File file,UpdateJournal.Identity identity,String plan,long generation,UpdateJournal.FreshnessCheck fresh) throws Exception {
    DevicePolicyManager policy=context.getSystemService(DevicePolicyManager.class);
    if(policy==null||!policy.isDeviceOwnerApp(context.getPackageName()))throw new IOException("Device-owner installation authority unavailable");
    PackageInstaller installer=context.getPackageManager().getPackageInstaller();
    PackageInstaller.SessionParams params=new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
    params.setAppPackageName(target);params.setSize(file.length());
    if(Build.VERSION.SDK_INT>=31)params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
    int id=installer.createSession(params);
    try(PackageInstaller.Session session=installer.openSession(id)) {
      try(InputStream input=new FileInputStream(file);OutputStream output=session.openWrite("base.apk",0,file.length())) {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");byte[] buffer=new byte[65536];int count;long size=0;
        while((count=input.read(buffer))!=-1){size+=count;if(size>file.length())throw new IOException("APK changed during session write");output.write(buffer,0,count);digest.update(buffer,0,count);}
        if(size!=file.length()||!identity.digest.equals(hex(digest.digest())))throw new IOException("Session APK integrity mismatch");
        session.fsync(output);
      }
      Intent intent=new Intent(context,callbackReceiver).setAction(callbackAction)
        .putExtra("transaction",plan).putExtra("expectedSession",id);
      int callbackFlags=PendingIntent.FLAG_UPDATE_CURRENT;
      if(Build.VERSION.SDK_INT>=31)callbackFlags|=PendingIntent.FLAG_MUTABLE;
      PendingIntent callback=PendingIntent.getBroadcast(context,id,intent,callbackFlags);
      if(fresh==null)journal.recoveringWithAction(plan,id,()->session.commit(callback.getIntentSender()));
      else journal.committingWithAction(plan,id,generation,fresh,()->session.commit(callback.getIntentSender()));
      return id;
    } catch(Exception failure) {
      // A throw from Session.commit does not prove the platform refused it, and
      // abandoning could race an install already under way. A session never
      // handed off, including one refused as stale, is abandoned here and leaves
      // the plan VERIFIED; after a handoff, readback abandons it only once the
      // platform has reported it uncommitted for long enough, since a sealed
      // session reads uncommitted while the platform verifies it, and decides the rest.
      if(!(failure instanceof UpdateJournal.HandoffFailed))try{installer.abandonSession(id);}catch(Exception ignored){}
      try{reconcilePending(context,target,journal,observationBudgetMs);}catch(Exception reconciliation){failure.addSuppressed(reconciliation);}
      throw failure;
    }
  }
  private void verify(File file,UpdateJournal.Identity expected,String distribution,byte[] runtime)throws Exception {
    Path privateRoot=context.getNoBackupFilesDir().toPath().toRealPath();Path resolved=file.toPath().toRealPath();
    if(!resolved.startsWith(privateRoot)||!Files.isRegularFile(file.toPath(),LinkOption.NOFOLLOW_LINKS)||file.length()>2L*1024*1024*1024)throw new IOException("APK must be a bounded private cached file");
    if(!expected.digest.equals(hash(file)))throw new IOException("Cached APK digest mismatch");
    PackageInfo info=context.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(),PackageManager.GET_SIGNING_CERTIFICATES|PackageManager.GET_META_DATA);
    if(info==null||!target.equals(info.packageName)||info.getLongVersionCode()!=expected.code||info.applicationInfo==null||info.signingInfo==null)throw new IOException("Wrong APK identity");
    if(info.signingInfo.hasMultipleSigners()||info.signingInfo.getApkContentsSigners().length!=1
        ||!signer.equals(hex(MessageDigest.getInstance("SHA-256").digest(info.signingInfo.getApkContentsSigners()[0].toByteArray()))))throw new IOException("APK signer mismatch");
    if(!testArtifacts) {
      verifyProductionManifest(file,info.applicationInfo);
      if(runtime==null||artifactHosts==null||runtimeAbi==null)throw new IOException("Authenticated runtime expectations missing");
      verifyRuntime(file,runtime.clone(),artifactHosts,runtimeAbi);
    }
    if(info.applicationInfo.metaData==null||!distribution.equals(info.applicationInfo.metaData.getString(distributionKey)))throw new IOException("APK distribution mismatch");
  }
  private void verifyProductionManifest(File file,ApplicationInfo info)throws Exception {
    // Some framework archive parsers return zero ApplicationInfo.flags. Inspect
    // the signed binary manifest itself, and fail closed on indirect values.
    info.sourceDir=file.getAbsolutePath();info.publicSourceDir=file.getAbsolutePath();
    android.content.res.Resources resources=context.getPackageManager().getResourcesForApplication(info);
    try(android.content.res.XmlResourceParser xml=resources.getAssets().openXmlResourceParser("AndroidManifest.xml")) {
      boolean found=false;
      for(int event=xml.getEventType();event!=org.xmlpull.v1.XmlPullParser.END_DOCUMENT;event=xml.next()) {
        if(event==org.xmlpull.v1.XmlPullParser.START_TAG && "application".equals(xml.getName())) {
          if(found)throw new IOException("Duplicate application manifest");found=true;
          for(String attr:new String[]{"debuggable","testOnly"}) {
            String value=xml.getAttributeValue("http://schemas.android.com/apk/res/android",attr);
            if(value!=null&&!"false".equals(value))throw new IOException("Debug or test APK forbidden");
          }
        }
      }
      if(!found)throw new IOException("Application manifest missing");
    }
  }
  public static UpdateJournal.Identity installed(Context context,String target)throws Exception {
    PackageInfo info=context.getPackageManager().getPackageInfo(target,0);
    if(info.applicationInfo==null || (info.applicationInfo.splitSourceDirs!=null && info.applicationInfo.splitSourceDirs.length>0))throw new IOException("Split package not supported by this release lane");
    return new UpdateJournal.Identity(info.getLongVersionCode(),hash(new File(info.applicationInfo.sourceDir)));
  }
  /** Safe after process death or a missing callback: see InstallReadback. */
  public static UpdateJournal.Snapshot reconcilePending(Context context,String target,UpdateJournal journal,long observationBudgetMs)throws Exception {
    return InstallReadback.reconcile(journal,platform(context,target),observationBudgetMs);
  }
  static InstallReadback.Platform platform(Context context,String target) {
    return new InstallReadback.Platform() {
      @Override public UpdateJournal.Identity installed()throws Exception{return PackageInstallCoordinator.installed(context,target);}
      @Override public InstallReadback.Session session(int id){return sessionState(context,target,id);}
      @Override public void abandon(int id){context.getPackageManager().getPackageInstaller().abandonSession(id);}
      @Override public long bootCount()throws Exception{return android.provider.Settings.Global.getInt(context.getContentResolver(),android.provider.Settings.Global.BOOT_COUNT);}
      @Override public long elapsedRealtime(){return android.os.SystemClock.elapsedRealtime();}
    };
  }
  /** Before API 29 the platform cannot say whether a session was committed. */
  public static InstallReadback.Session sessionState(Context context,String target,int id) {
    for(PackageInstaller.SessionInfo session:context.getPackageManager().getPackageInstaller().getMySessions()) {
      if(session.getSessionId()!=id||!target.equals(session.getAppPackageName()))continue;
      if(Build.VERSION.SDK_INT<29)return InstallReadback.Session.UNKNOWN;
      return session.isCommitted()?InstallReadback.Session.COMMITTED:InstallReadback.Session.UNCOMMITTED;
    }
    return InstallReadback.Session.GONE;
  }
  public static boolean hasPendingSession(Context context,String target,int id) {
    return sessionState(context,target,id)!=InstallReadback.Session.GONE;
  }
  public static String hash(File file)throws Exception {
    MessageDigest digest=MessageDigest.getInstance("SHA-256");
    try(InputStream in=new FileInputStream(file)){byte[] buffer=new byte[65536];int count;while((count=in.read(buffer))!=-1)digest.update(buffer,0,count);}
    return hex(digest.digest());
  }
  private static String hex(byte[] bytes){StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();}
}
