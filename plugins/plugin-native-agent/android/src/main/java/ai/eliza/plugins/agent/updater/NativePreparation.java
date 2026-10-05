package ai.eliza.plugins.agent.updater;
import ai.eliza.plugins.agent.runtime.AndroidRuntimeDirectories;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.system.Os;
import java.io.*;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;

/** Supervisor-private discovery -> staging -> APK verification -> journal flow.
 * A qualified native provider is required; there is no renderer, default clock,
 * credentials, fixture fallback, install call or production auto-enrollment. */
public final class NativePreparation implements PreparationFlow.Ports,AutoCloseable {
 public static class Inputs {
  public final byte[] compatibilityObservations;public final long securityFloor,reserveBytes;
  public Inputs(byte[] observations,long floor,long reserve){compatibilityObservations=observations.clone();securityFloor=floor;reserveBytes=reserve;}
 }
 // readTime must return qualified fresh bounds without network/blocking work;
 // it is also called from TLS workers and while the journal lock is held.
 public interface InputProvider { Inputs read()throws Exception; QualifiedClockAnchor.Interval readTime()throws Exception; }
 public interface Trust extends PreparedAuthorizationStore.Authority {
  Enrollment readEnrollment(String directory)throws Exception;
  EnrolledDiscovery newEnrolledDiscoveryWithTimeSource(String directory,InputProvider time)throws Exception;
  PreparedStager newPreparedStagerWithTimeSource(String directory,InputProvider time)throws Exception;
  CheckDecision beginStagingInterval(String directory,long lower,long upper,long generation)throws Exception;
  CheckDecision finishStagingInterval(String directory,String token,long lower,long upper,boolean success,long retryAfter)throws Exception;
  String evaluateRememberedReleaseInterval(String directory,byte[] descriptor,byte[] device,byte[] policy)throws Exception;
 }
 public interface EnrolledDiscovery extends AutoCloseable {
  @Override void close();
  DiscoveryResult runWithTimeSource(String schedule,String trust,String admission,String prepared,byte[] device,long floor,long generation)throws Exception;
 }
 public interface PreparedStager extends AutoCloseable {
  @Override void close();
  StagedPair stageWithTimeSource(String prepared,String admission,String artifacts,String id,byte[] device,long floor,long generation,long reserve)throws Exception;
  long retryAfterMillis();
 }
 public record Enrollment(byte[] config,byte[] root,String cohortID) {
  public Enrollment {config=config.clone();root=root.clone();}
  public byte[] getConfig(){return config.clone();}public byte[] getRoot(){return root.clone();}public String getCohortID(){return cohortID;}
 }
 public record DiscoveryResult(String status,boolean hasAdmission,long generation,byte[] descriptor,String authorizationID) {
  public String getStatus(){return status;}public Object getAdmission(){return hasAdmission?Boolean.TRUE:null;}
  public long getGeneration(){return generation;}public byte[] getDescriptor(){return descriptor;}public String getAuthorizationID(){return authorizationID;}
 }
 public record StagedPair(long generation,byte[] descriptor,String authorizationID,String candidatePath,String recoveryPath) {
  public long getGeneration(){return generation;}public byte[] getDescriptor(){return descriptor;}public String getAuthorizationID(){return authorizationID;}
  public String getCandidatePath(){return candidatePath;}public String getRecoveryPath(){return recoveryPath;}
 }
 public record CheckDecision(String token,boolean superseded) {public String getToken(){return token;}public boolean getSuperseded(){return superseded;}}
 public interface ArtifactVerifier {void verify(String signer,byte[] candidate,byte[] recovery,String hosts,String abi,File candidateFile,File recoveryFile,UpdateJournal.Plan plan,long generation)throws Exception;}
 private final Trust trust;private final String targetPackage,distributionKey;private final ArtifactVerifier verifier;
 private final Context context;private final UpdateJournal journal;private final InputProvider inputs;
 private final PreparationFlow.Resources resources;private final File root;private final Enrollment enrollment;private final JSONObject config;
 private NativePreparation(Context context,UpdateJournal journal,String targetPackage,String distributionKey,Trust trust,ArtifactVerifier verifier,InputProvider inputs,PreparationFlow.Resources resources)throws Exception {
  this.context=context;this.inputs=inputs;this.resources=resources;root=context.getNoBackupFilesDir();this.journal=Objects.requireNonNull(journal);this.targetPackage=Objects.requireNonNull(targetPackage);this.distributionKey=Objects.requireNonNull(distributionKey);this.trust=Objects.requireNonNull(trust);this.verifier=Objects.requireNonNull(verifier);
  enrollment=trust.readEnrollment(path("ota-enrollment"));config=new JSONObject(new String(enrollment.getConfig(),StandardCharsets.UTF_8));
 }
 public static PreparationFlow.Outcome run(Context context,UpdateJournal journal,String targetPackage,String distributionKey,Trust trust,ArtifactVerifier verifier,InputProvider inputs,JobRunRegistry.Cancellation cancellation)throws Exception {
  try(PreparationFlow.Resources resources=new PreparationFlow.Resources()) {
   cancellation.onCancel(resources::close);PreparationFlow.check(cancellation);
   try(NativePreparation flow=new NativePreparation(context,journal,targetPackage,distributionKey,trust,verifier,inputs,resources)) {
   Path lockPath=new File(flow.root,"ota-preparation.lock").toPath();
   if(Files.exists(lockPath,LinkOption.NOFOLLOW_LINKS)&&!Files.isRegularFile(lockPath,LinkOption.NOFOLLOW_LINKS))throw new IOException("Unsafe preparation lock");
   try(FileChannel channel=FileChannel.open(new File(flow.root,"ota-preparation.lock").toPath(),StandardOpenOption.CREATE,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS)) {
    try(FileLock lock=channel.tryLock()) {
     if(lock==null)return PreparationFlow.Outcome.BUSY;
     if(!Files.isRegularFile(new File(flow.root,"ota-preparation.lock").toPath(),LinkOption.NOFOLLOW_LINKS))throw new IOException("Unsafe preparation lock");
     return PreparationFlow.run(flow,cancellation);
    } catch(OverlappingFileLockException busy){return PreparationFlow.Outcome.BUSY;}
   }
   }
  }
 }
 private QualifiedClockAnchor.Interval currentTime()throws Exception {
  QualifiedClockAnchor.Interval value=inputs.readTime();if(value==null)throw new IOException("Qualified time unavailable");
  return new QualifiedClockAnchor.Interval(value.lower,value.upper);
 }
 private String path(String name){return new File(root,name).getAbsolutePath();}
 private String working(String name)throws Exception {
  Path directory=new File(root,name).toPath();
  if(!Files.exists(directory,LinkOption.NOFOLLOW_LINKS)){Files.createDirectory(directory);Os.chmod(directory.toString(),0700);AndroidRuntimeDirectories.syncRuntimeDirectory(root.toPath());}
  if(!Files.isDirectory(directory,LinkOption.NOFOLLOW_LINKS))throw new IOException("Unsafe preparation directory");return directory.toString();
 }
 @Override public PreparationFlow.Fence capture()throws Exception {
  UpdateJournal.Snapshot state=journal.read();
  boolean busy=state.phase!=UpdateJournal.Phase.IDLE&&state.phase!=UpdateJournal.Phase.STAGING&&state.phase!=UpdateJournal.Phase.HEALTHY&&state.phase!=UpdateJournal.Phase.RECOVERED&&state.phase!=UpdateJournal.Phase.QUARANTINED;
  return new PreparationFlow.Fence(state.channel,state.channelGeneration,PackageInstallCoordinator.installed(context,targetPackage),busy);
 }
 @Override public void prune()throws Exception {working("ota-prepared");new PreparedAuthorizationStore(journal,new File(root,"ota-prepared"),trust).prune();}
 private static final class Observed {
  final Inputs input;final byte[] device;final String abi;
  Observed(Inputs input,byte[] device,String abi){this.input=input;this.device=device;this.abi=abi;}
 }
 private Observed observe(PreparationFlow.Fence fence)throws Exception {
  Inputs values=inputs.read();JSONObject device=new JSONObject(new String(values.compatibilityObservations,StandardCharsets.UTF_8));
  UpdateJournal.Snapshot state=journal.read();UpdateJournal.Identity installed=PackageInstallCoordinator.installed(context,targetPackage);
  if(state.channelGeneration!=fence.generation||!state.channel.equals(fence.channel)||!installed.matches(fence.installed))throw new IOException("Native observations changed");
  PackageInfo info=context.getPackageManager().getPackageInfo(targetPackage,PackageManager.GET_SIGNING_CERTIFICATES|PackageManager.GET_META_DATA);
  if(info.signingInfo==null||info.signingInfo.hasMultipleSigners()||info.signingInfo.getApkContentsSigners().length!=1||info.applicationInfo==null)throw new IOException("Installed identity unavailable");
  if(info.applicationInfo.metaData==null||!info.applicationInfo.metaData.containsKey(distributionKey))throw new IOException("Installed distribution metadata unavailable; qualified bridge required");
  String distribution=info.applicationInfo.metaData.getString(distributionKey);
  StringBuilder signer=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(info.signingInfo.getApkContentsSigners()[0].toByteArray()))signer.append(String.format(Locale.ROOT,"%02x",b&255));
  if(!config.getString("distribution").equals(distribution)||!config.getString("signerSha256").equals(signer.toString()))throw new IOException("Installed package enrollment mismatch");
  if(Build.SUPPORTED_ABIS.length==0)throw new IOException("Native ABI unavailable");String abi=Build.SUPPORTED_ABIS[0];
  device.put("requestedChannel",state.channel).put("distribution",distribution).put("quarantine",new JSONArray(state.quarantine))
   .put("installedSha256",installed.digest).put("installedVersionCode",installed.code).put("signerSha256",signer.toString())
   .put("sdk",Build.VERSION.SDK_INT).put("abi",abi).put("model",Build.MODEL).put("buildFingerprint",Build.FINGERPRINT)
   .put("supervisorVersion",context.getPackageManager().getPackageInfo(context.getPackageName(),0).getLongVersionCode())
   .put("freeBytes",root.getUsableSpace()).put("opaqueCohortId",enrollment.getCohortID());
  return new Observed(values,device.toString().getBytes(StandardCharsets.UTF_8),abi);
 }
 private static final class Candidate implements PreparationFlow.Prepared {final String id;Candidate(String id){this.id=id;}}
 @Override public PreparationFlow.Prepared discover(PreparationFlow.Fence fence)throws Exception {
  UpdateJournal.Snapshot queued=journal.read();
  if(queued.phase==UpdateJournal.Phase.STAGING&&!queued.plan.baseline.matches(fence.installed))journal.discardStaging(queued.plan.id,fence.generation);
  Observed observed=observe(fence);EnrolledDiscovery session=trust.newEnrolledDiscoveryWithTimeSource(path("ota-enrollment"),inputs);resources.attach(session::close);
  try {
   DiscoveryResult result=session.runWithTimeSource(working("ota-schedule"),working("ota-trust-"+fence.channel+"-"+config.getString("distribution")),path("ota-admission"),path("ota-prepared"),observed.device,observed.input.securityFloor,fence.generation);
   queued=journal.read();
   if(!"admitted".equals(result.getStatus())) {
    // A scheduling deferral has no admission result. Continue the previously
    // authorized queued transfer; the stager rechecks eligibility and expiry.
    if(queued.phase==UpdateJournal.Phase.STAGING) {
     if(result.getAdmission()==null)return new Candidate(queued.plan.id);
     journal.discardStaging(queued.plan.id,fence.generation);
    }
    return null;
   }
   if(result.getGeneration()!=fence.generation)throw new IOException("Discovery generation changed");
   JSONObject descriptor=new JSONObject(new String(result.getDescriptor(),StandardCharsets.UTF_8));
   JSONObject a=descriptor.getJSONObject("candidate"),b=descriptor.getJSONObject("recovery");
   UpdateJournal.Plan plan=new UpdateJournal.Plan(result.getAuthorizationID(),descriptor.getString("channel"),descriptor.getString("distribution"),fence.installed,
    new UpdateJournal.Identity(a.getLong("versionCode"),a.getString("sha256")),new UpdateJournal.Identity(b.getLong("versionCode"),b.getString("sha256")));
   if(queued.phase==UpdateJournal.Phase.STAGING&&!queued.plan.id.equals(plan.id)){journal.discardStaging(queued.plan.id,fence.generation);queued=journal.read();}
   if(queued.phase!=UpdateJournal.Phase.STAGING)journal.stageValidated(plan,PackageInstallCoordinator.installed(context,targetPackage),fence.generation,()->{
    try{trust.verify(path("ota-prepared"),plan,fence.generation,a.toString().getBytes(StandardCharsets.UTF_8),b.toString().getBytes(StandardCharsets.UTF_8));}
    catch(Exception failure){throw new IOException("Cannot retain staging authorization",failure);}
   });
   return new Candidate(plan.id);
  }finally{resources.release();}
 }
 private static final class Pair implements PreparationFlow.Staged {
  final StagedPair staged;final UpdateJournal.Plan plan;final byte[] candidate,recovery;final String abi;
  Pair(StagedPair staged,PreparationFlow.Fence fence,String abi)throws Exception {
   this.staged=staged;this.abi=abi;JSONObject descriptor=new JSONObject(new String(staged.getDescriptor(),StandardCharsets.UTF_8));JSONObject a=descriptor.getJSONObject("candidate"),b=descriptor.getJSONObject("recovery");
   if(staged.getGeneration()!=fence.generation||!descriptor.getString("channel").equals(fence.channel))throw new IOException("Staged generation changed");
   plan=new UpdateJournal.Plan(staged.getAuthorizationID(),descriptor.getString("channel"),descriptor.getString("distribution"),fence.installed,new UpdateJournal.Identity(a.getLong("versionCode"),a.getString("sha256")),new UpdateJournal.Identity(b.getLong("versionCode"),b.getString("sha256")));
   candidate=a.toString().getBytes(StandardCharsets.UTF_8);recovery=b.toString().getBytes(StandardCharsets.UTF_8);
  }
 }
 private static final class StagingAttempt {
  final String directory,token;long retryAfter;
  StagingAttempt(String directory,String token){this.directory=directory;this.token=token;}
 }
 private StagingAttempt attempt;
 private void finishAttempt(boolean success)throws Exception {
  StagingAttempt current=attempt;if(current==null)return;attempt=null;
  QualifiedClockAnchor.Interval time=currentTime();
  CheckDecision finished=trust.finishStagingInterval(current.directory,current.token,time.lower,time.upper,success,current.retryAfter);
  if(finished.getSuperseded())throw new IOException("Staging schedule superseded");
 }
 @Override public void close()throws Exception {finishAttempt(false);}
 @Override public PreparationFlow.Staged stage(PreparationFlow.Prepared prepared,PreparationFlow.Fence fence)throws Exception {
  Observed observed=observe(fence);String schedule=working("ota-staging-schedule");QualifiedClockAnchor.Interval time=currentTime();
  CheckDecision claim=trust.beginStagingInterval(schedule,time.lower,time.upper,fence.generation);
  if(claim.getToken().isEmpty())return null;
  attempt=new StagingAttempt(schedule,claim.getToken());
  PreparedStager stager=null;boolean attached=false;
  try {
   stager=trust.newPreparedStagerWithTimeSource(path("ota-enrollment"),inputs);PreparedStager active=stager;resources.attach(active::close);attached=true;
   return new Pair(stager.stageWithTimeSource(path("ota-prepared"),path("ota-admission"),working("ota-artifacts"),((Candidate)prepared).id,observed.device,observed.input.securityFloor,fence.generation,observed.input.reserveBytes),fence,observed.abi);
  }finally {
   attempt.retryAfter=stager==null?0:stager.retryAfterMillis();
   if(attached)resources.release();else if(stager!=null)stager.close();
  }
 }
 private String hosts()throws Exception {JSONArray values=config.getJSONArray("approvedHosts");List<String> hosts=new ArrayList<>();for(int i=0;i<values.length();i++)hosts.add(values.getString(i));return String.join(",",hosts);}
 @Override public void verify(PreparationFlow.Staged staged,PreparationFlow.Fence fence)throws Exception {
  Pair pair=(Pair)staged;
  verifier.verify(config.getString("signerSha256"),pair.candidate,pair.recovery,hosts(),pair.abi,new File(pair.staged.getCandidatePath()),new File(pair.staged.getRecoveryPath()),pair.plan,fence.generation);
 }
 @Override public void admit(PreparationFlow.Staged staged,PreparationFlow.Fence fence,JobRunRegistry.Cancellation cancellation)throws Exception {
  Pair pair=(Pair)staged;Observed observed=observe(fence);
  Enrollment current=trust.readEnrollment(path("ota-enrollment"));
  if(!Arrays.equals(enrollment.getConfig(),current.getConfig())||!Arrays.equals(enrollment.getRoot(),current.getRoot())||!enrollment.getCohortID().equals(current.getCohortID()))throw new IOException("Enrollment changed before admission");
  journal.beginValidated(pair.plan,PackageInstallCoordinator.installed(context,targetPackage),fence.generation,()->{
   PreparationFlow.check(cancellation);
   try {
    QualifiedClockAnchor.Interval time=currentTime();
    JSONObject policy=new JSONObject().put("repository",config.getString("repository")).put("artifactHosts",config.getJSONArray("approvedHosts"))
     .put("trustedLowerMs",time.lower).put("trustedUpperMs",time.upper).put("minimumSequence",1).put("minimumRolloutRevision",1).put("securityFloor",observed.input.securityFloor);
    String decision=trust.evaluateRememberedReleaseInterval(path("ota-admission"),pair.staged.getDescriptor(),observed.device,policy.toString().getBytes(StandardCharsets.UTF_8));
    if(!"eligible".equals(decision))throw new IOException("Release no longer eligible");
    trust.verify(path("ota-prepared"),pair.plan,fence.generation,pair.candidate,pair.recovery);
   }catch(Exception failure){throw new IOException("Final prepared authorization rejected",failure);}
   PreparationFlow.check(cancellation);
  });
  finishAttempt(true);
 }
}
