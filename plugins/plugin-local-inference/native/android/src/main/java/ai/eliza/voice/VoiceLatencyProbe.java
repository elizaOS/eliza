package ai.eliza.voice;

import android.content.Context;
import android.media.AudioRecord;
import android.media.AudioTimestamp;
import android.media.MediaPlayer;
import android.media.MediaTimestamp;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.PowerManager;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.function.BooleanSupplier;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The Android side of the native voice latency collector ({@link VoiceLatencyTrials}).
 *
 * <ul>
 * <li>Capture: {@link #captureTimeNs} maps an AudioRecord frame position to CLOCK_MONOTONIC with
 *     AudioRecord.getTimestamp (TIMEBASE_MONOTONIC), so the last speech sample is timed where it was
 *     captured, not where the read returned. When the platform has no timestamp the read-return time
 *     is used and the trial says so ({@code read-return}): that is later than capture, so the
 *     latency it yields is a lower bound and never acceptance evidence.</li>
 * <li>Streamed playback (engines with Paradee streaming): {@code first-pcm} is the first
 *     AudioTrack write of the reply and {@code audible-playback} the AudioTrack.getTimestamp
 *     (CLOCK_MONOTONIC) presentation time of the first non-silent sample ({@code audiotrack-timestamp});
 *     the playback head crossing it is only a labelled fallback ({@code audiotrack-head-position}).
 *     See {@link StreamingSpeechPlayback}.</li>
 * <li>Whole-sentence playback: local replies play through the host's MediaPlayer. {@code first-pcm}
 *     is MediaPlayer.start(); {@code audible-playback} is the presentation time of the first
 *     non-silent sample from MediaPlayer.getTimestamp (backed by the AudioTrack's output timestamp),
 *     read once the media clock has run {@link #AUDIBLE_ANCHOR_US} (or half of a shorter clip) so the anchor comes from rendered
 *     audio rather than the start estimate. It is the output pipeline's time, not an acoustic one.</li>
 * </ul>
 * Records hold numbers and fixed labels plus the build and model identity; nothing is written to
 * storage or logged. {@link #export} is one timing document whose format name and source/build
 * identity the host supplies once with {@link #configureHost}, so an installed product keeps the
 * document name its own tooling already reads.
 */
public final class VoiceLatencyProbe {
 public static final String DEFAULT_FORMAT="eliza-native-voice-timing-v3";
 public static final VoiceLatencyTrials TRIALS=new VoiceLatencyTrials(System::nanoTime);
 private static volatile String format=DEFAULT_FORMAT,sourceCommit="unknown",build="unknown";
 private static volatile boolean sourceDirty;
 /**
  * The export document name and the host build identity. Call before the first capture or export;
  * identity is computed once per process. Values are labels only, never credentials.
  */
 public static synchronized void configureHost(String documentFormat,String commit,boolean dirty,String buildName){
  if(documentFormat==null||!documentFormat.matches("[a-z0-9-]{1,64}"))throw new IllegalArgumentException("Invalid timing format");
  String nextCommit=commit==null||commit.isEmpty()?"unknown":commit,nextBuild=buildName==null||buildName.isEmpty()?"unknown":buildName;
  if(identity!=null&&!(documentFormat.equals(format)&&nextCommit.equals(sourceCommit)&&dirty==sourceDirty&&nextBuild.equals(build)))throw new IllegalStateException("Voice timing identity already computed");
  format=documentFormat;sourceCommit=nextCommit;sourceDirty=dirty;build=nextBuild;
 }
 public static String format(){return format;}
 /** Media time after which the MediaPlayer anchor is taken from rendered output. */
 public static final long AUDIBLE_ANCHOR_US=200_000;
 private static final long AUDIBLE_POLL_MS=10,AUDIBLE_WAIT_MS=5000;
 /** -40 dBFS: the first sample at or above it is the audible response start. */
 public static final float AUDIBLE_LEVEL=0.01f;
 private static volatile JSONObject identity;
 private VoiceLatencyProbe(){}

 /** CLOCK_MONOTONIC capture time of {@code frame} (0-based since startRecording), or UNSET. */
 public static long captureTimeNs(AudioRecord recorder,AudioTimestamp scratch,long frame,int sampleRate){
  try{
   if(recorder.getTimestamp(scratch,AudioTimestamp.TIMEBASE_MONOTONIC)!=AudioRecord.SUCCESS||scratch.nanoTime<=0)return VoiceLatencyTrials.UNSET;
   return VoiceLatencyTrials.frameTimeNs(scratch.nanoTime,scratch.framePosition,frame,sampleRate);
  }catch(RuntimeException unavailable){return VoiceLatencyTrials.UNSET;}
 }

 /** Index of the first sample at or above {@link #AUDIBLE_LEVEL}, or -1 for a silent clip. */
 public static int leadInFrames(float[] samples){
  for(int i=0;i<samples.length;i++)if(Math.abs(samples[i])>=AUDIBLE_LEVEL)return i;
  return -1;
 }

 /**
  * The player has just been started with a local spoken reply. Stamps first-pcm on the admitted turn and
  * polls the player's timestamp on {@code handler} until the audible start is known. {@code current}
  * turns false when the player was replaced or released.
  */
 public static void playbackStarted(VoiceLatencyTrials.Trial owner,Context context,MediaPlayer player,Handler handler,int leadInFrames,int totalFrames,int sampleRate,BooleanSupplier current){
  VoiceLatencyTrials.Trial trial=TRIALS.firstPcm(owner,System.nanoTime());
  if(trial==null)return;
  stampEnvironment(context,trial);
  if(leadInFrames<0||sampleRate<=0){TRIALS.failed(trial,"silent-response");return;}
  long leadUs=leadInFrames*1_000_000L/sampleRate,anchorUs=Math.min(AUDIBLE_ANCHOR_US,totalFrames*1_000_000L/sampleRate/2),deadline=System.nanoTime()+AUDIBLE_WAIT_MS*1_000_000L;
  Runnable poll=new Runnable(){public void run(){
   if(!current.getAsBoolean()){TRIALS.failed(trial,"playback-stopped");return;}
   MediaTimestamp timestamp;
   try{timestamp=player.getTimestamp();}catch(IllegalStateException released){TRIALS.failed(trial,"playback-stopped");return;}
   if(timestamp!=null&&timestamp.getMediaClockRate()>0&&timestamp.getAnchorMediaTimeUs()>=anchorUs){
    long audible=VoiceLatencyTrials.presentationNs(timestamp.getAnchorSystemNanoTime(),timestamp.getAnchorMediaTimeUs(),leadUs,timestamp.getMediaClockRate());
    if(TRIALS.audible(trial,audible,"mediaplayer-timestamp"))return;
   }
   if(System.nanoTime()>deadline){TRIALS.failed(trial,"no-audible-time");return;}
   handler.postDelayed(this,AUDIBLE_POLL_MS);
  }};
  handler.post(poll);
 }

 /** Network and thermal state at response time. */
 public static void stampEnvironment(Context context,VoiceLatencyTrials.Trial trial){
  String network="offline";
  try{
   ConnectivityManager connectivity=context.getSystemService(ConnectivityManager.class);
   NetworkCapabilities capabilities=connectivity==null||connectivity.getActiveNetwork()==null?null:connectivity.getNetworkCapabilities(connectivity.getActiveNetwork());
   if(capabilities!=null)network=capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)?"wifi":capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)?"cellular":capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)?"ethernet":"other";
  }catch(RuntimeException unavailable){network="unknown";}
  String thermal="unknown";float headroom=Float.NaN;
  PowerManager power=context.getSystemService(PowerManager.class);
  if(power!=null){
   // Thermal status is API 29+; the library also serves minSdk 26 hosts, which report "unknown".
   if(Build.VERSION.SDK_INT>=29)thermal=thermalName(power.getCurrentThermalStatus());
   if(Build.VERSION.SDK_INT>=30)try{headroom=power.getThermalHeadroom(0);}catch(RuntimeException unavailable){headroom=Float.NaN;}
  }
  TRIALS.environment(trial,network,thermal,headroom);
 }
 public static String thermalName(int status){
  switch(status){
   case PowerManager.THERMAL_STATUS_NONE:return "none";
   case PowerManager.THERMAL_STATUS_LIGHT:return "light";
   case PowerManager.THERMAL_STATUS_MODERATE:return "moderate";
   case PowerManager.THERMAL_STATUS_SEVERE:return "severe";
   case PowerManager.THERMAL_STATUS_CRITICAL:return "critical";
   case PowerManager.THERMAL_STATUS_EMERGENCY:return "emergency";
   case PowerManager.THERMAL_STATUS_SHUTDOWN:return "shutdown";
   default:return "unknown";
  }
 }

 /** True on the Android emulator (ranchu/goldfish) or Cuttlefish; their audio and CPU timing are not a phone's. */
 public static boolean emulator(){
  String hardware=Build.HARDWARE==null?"":Build.HARDWARE.toLowerCase(Locale.ROOT);
  String product=Build.PRODUCT==null?"":Build.PRODUCT.toLowerCase(Locale.ROOT),fingerprint=Build.FINGERPRINT==null?"":Build.FINGERPRINT.toLowerCase(Locale.ROOT);
  return hardware.contains("ranchu")||hardware.contains("goldfish")||hardware.contains("cutf")||hardware.contains("vsoc")
   ||fingerprint.startsWith("generic")||fingerprint.contains("emulator")||fingerprint.contains("cf_x86")||fingerprint.contains("cf_arm")
   ||product.startsWith("sdk_")||product.contains("emulator")||product.startsWith("cf_")||product.contains("vsoc");
 }

 /** Source commit, engine and model hashes, device and ABI. Computed once per process. */
 public static JSONObject identity(Context context)throws Exception{
  JSONObject cached=identity;
  if(cached!=null)return cached;
  String libraries=context.getApplicationInfo().nativeLibraryDir;
  String abiDirectory=new File(libraries).getName();
  String abi="arm64".equals(abiDirectory)||"arm64-v8a".equals(abiDirectory)?"arm64-v8a":"x86_64".equals(abiDirectory)?"x86_64":abiDirectory;
  File engine=new File(libraries,"libelizainference.so");
  byte[] manifest;try(InputStream in=context.getAssets().open(VoiceAssets.ASSET_ROOT+"/manifest.json")){manifest=readAll(in,1<<20);}
  JSONObject models=new JSONObject();
  JSONArray files=new JSONObject(new String(manifest,java.nio.charset.StandardCharsets.UTF_8)).getJSONArray("files");
  for(int i=0;i<files.length();i++){
   JSONObject file=files.getJSONObject(i);String path=file.getString("path");
   if(path.startsWith("asr/")&&path.endsWith(".gguf"))models.put("asr",file.getString("sha256"));
   else if(path.startsWith("vad/")&&path.endsWith(".gguf"))models.put("vad",file.getString("sha256"));
   else if(path.startsWith("tts/")&&path.endsWith(".gguf"))models.put("tts",file.getString("sha256"));
  }
  JSONObject value=new JSONObject()
   .put("sourceCommit",sourceCommit)
   .put("sourceDirty",sourceDirty)
   .put("engineSha256",engine.isFile()?sha256(engine):"unavailable")
   .put("modelSha256",sha256(manifest))
   .put("models",models)
   .put("device",(Build.MANUFACTURER+" "+Build.MODEL).trim())
   .put("environment",emulator()?"emulator":"device")
   .put("abi",abi)
   .put("sdk",Build.VERSION.SDK_INT)
   .put("build",build);
  identity=value;return value;
 }

 /** Hashes the engine and model identity off the caller's thread so the first export does not wait on it. */
 public static void prepareIdentity(Context context){
  if(identity!=null)return;
  Context app=context.getApplicationContext();
  Thread thread=new Thread(()->{try{identity(app);}catch(Exception unavailable){/* export computes it again and reports the failure */}},"eliza-voice-identity");
  thread.setDaemon(true);thread.start();
 }
 /** Every finished trial as one timing document in the configured {@link #format}. */
 public static JSONObject export(Context context)throws Exception{
  JSONObject id=identity(context);
  JSONArray records=new JSONArray();
  for(VoiceLatencyTrials.Trial trial:TRIALS.snapshot())records.put(record(trial,id));
  return new JSONObject().put("format",format).put("clock","CLOCK_MONOTONIC").put("units","ms").put("marks",new JSONArray(java.util.Arrays.asList(VoiceLatencyTrials.MARKS))).put("dropped",TRIALS.dropped()).put("records",records);
 }
 public static JSONObject record(VoiceLatencyTrials.Trial trial,JSONObject identity)throws JSONException{
  JSONObject marks=new JSONObject();
  for(int i=0;i<VoiceLatencyTrials.MARKS.length;i++)if(trial.marks[i]!=VoiceLatencyTrials.UNSET)marks.put(VoiceLatencyTrials.MARKS[i],trial.marks[i]/1e6);
  JSONObject row=new JSONObject().put("id",identity.optString("sourceCommit","").substring(0,Math.min(12,identity.optString("sourceCommit","").length()))+"-"+processTag()+"-"+trial.sequence)
   .put("turnId",trial.turnId).put("pipeline",trial.pipeline).put("clock","native-monotonic-ms").put("captureClock",trial.captureClock).put("cold",trial.cold).put("outcome",trial.outcome).put("identity",identity).put("marks",marks);
  if(trial.coldReason!=null)row.put("coldReason",trial.coldReason);
  if(trial.reason!=null)row.put("reason",trial.reason);
  if(trial.audibleClock!=null)row.put("audibleClock",trial.audibleClock);
  if(trial.network!=null)row.put("network",trial.network);
  if(trial.thermal!=null)row.put("thermal",trial.thermal);
  if(Float.isFinite(trial.thermalHeadroom))row.put("thermalHeadroom",(double)trial.thermalHeadroom);
  return row;
 }
 private static final String PROCESS_TAG=Long.toHexString(System.nanoTime()^android.os.Process.myPid());
 private static String processTag(){return PROCESS_TAG;}
 public static String sha256(File file)throws Exception{try(InputStream in=new FileInputStream(file)){MessageDigest digest=MessageDigest.getInstance("SHA-256");byte[] buffer=new byte[1<<16];int count;while((count=in.read(buffer))!=-1)digest.update(buffer,0,count);return hex(digest.digest());}}
 public static String sha256(byte[] bytes)throws Exception{return hex(MessageDigest.getInstance("SHA-256").digest(bytes));}
 private static String hex(byte[] bytes){StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();}
 private static byte[] readAll(InputStream in,int limit)throws java.io.IOException{java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[8192];int count;while((count=in.read(buffer))!=-1){if(out.size()+count>limit)throw new java.io.IOException("Manifest too large");out.write(buffer,0,count);}return out.toByteArray();}
}
