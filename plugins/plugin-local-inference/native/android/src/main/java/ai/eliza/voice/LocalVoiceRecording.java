package ai.eliza.voice;

import android.content.Context;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.io.File;
import java.io.IOException;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.Function;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One foreground-only private audio draft: a bounded mono 16 kHz AAC recording in the app cache.
 * Capture, transcription and keeping the audio are separate user actions; nothing here uploads or
 * retains it. A host names the cache file prefix (its installed-data identity) and receives
 * automatic stops (duration or size limit, microphone error) as events. {@link #selected} hands
 * the finished draft to transcription and the host's own storage; {@link #cancel} deletes it.
 * Results are plain {@link JSONObject}s so a bridge can forward them unchanged.
 */
public final class LocalVoiceRecording {
 /** Recording durations a host may request, in milliseconds. */
 public static final int SHORT_LIMIT_MS=29000,LONG_LIMIT_MS=59000;
 /** Largest draft kept, in bytes. */
 public static final int MAX_BYTES=4*1024*1024;
 private final Context context;
 private final String prefix;
 private final Consumer<JSONObject> events;
 private final Handler handler=new Handler(Looper.getMainLooper());
 private MediaRecorder recorder;
 private LocalMicrophoneLease microphone;
 private File file;
 private String id;
 private long startedAt;
 private long durationMs;
 private Runnable deadline;
 private boolean interrupted;
 private volatile Function<String,File> also;

 /** Deletes drafts a previous process left behind under {@code prefix}. */
 public LocalVoiceRecording(Context context,String prefix,Consumer<JSONObject> events){
  if(prefix==null||!prefix.matches("[a-z][a-z0-9-]{0,63}"))throw new IllegalArgumentException("Invalid recording prefix");
  this.context=context;this.prefix=prefix;this.events=events;
  File[] stale=context.getCacheDir().listFiles((dir,name)->name.startsWith(prefix)&&name.endsWith(".m4a"));
  if(stale!=null)for(File candidate:stale)candidate.delete();
 }
 private static JSONObject put(JSONObject value,String key,Object item){try{return value.put(key,item);}catch(JSONException error){throw new IllegalStateException(error);}}
 /** Checks admission without acquiring or replacing any microphone owner. */
 public synchronized void checkStart(int maxDurationMs){
  if(maxDurationMs!=SHORT_LIMIT_MS&&maxDurationMs!=LONG_LIMIT_MS)throw new IllegalArgumentException("Unsupported capture duration");
  if(file!=null)throw new IllegalStateException("Finish or discard the current recording first");
 }
 public synchronized JSONObject start(int maxDurationMs)throws IOException{
  checkStart(maxDurationMs);
  microphone=LocalMicrophoneLease.acquire();
  try{
   id=UUID.randomUUID().toString();file=new File(context.getCacheDir(),prefix+id+".m4a");
   recorder=new MediaRecorder();
   recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
   recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
   recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
   recorder.setAudioChannels(1);recorder.setAudioSamplingRate(16000);recorder.setAudioEncodingBitRate(64000);
   recorder.setOutputFile(file.getAbsolutePath());recorder.setMaxDuration(maxDurationMs);recorder.setMaxFileSize(MAX_BYTES);
   recorder.setOnInfoListener((source,what,extra)->{
    synchronized(this){if(recorder!=source)return;if(what==MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED||what==MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED)stopAutomatically();}
   });
   recorder.setOnErrorListener((source,what,extra)->{JSONObject result=new JSONObject();synchronized(this){if(recorder!=source||interrupted)return;put(result,"recordingId",id);cancel();}put(result,"status","failed");put(result,"message","Recording stopped because Android reported a microphone error");events.accept(result);});
   recorder.prepare();recorder.start();startedAt=SystemClock.elapsedRealtime();
   final String ownedId=id;deadline=()->{synchronized(this){if(!ownedId.equals(id))return;stopAutomatically();}};handler.postDelayed(deadline,maxDurationMs);
   JSONObject result=new JSONObject();put(result,"status","recording");put(result,"recordingId",id);put(result,"maxDurationMs",maxDurationMs);return result;
  }catch(IOException|RuntimeException|Error error){
   try{cancel();}catch(RuntimeException|Error cleanup){if(cleanup!=error)error.addSuppressed(cleanup);}
   throw error;
  }
 }
 /** Genuine peak from the already-owned microphone capture; no second stream or inferred RMS. */
 public synchronized JSONObject metrics(String recordingId){
  if(recorder==null||interrupted||id==null||!id.equals(recordingId))throw new IllegalStateException("Recording changed");
  JSONObject result=new JSONObject();put(result,"recordingId",id);put(result,"peak",Math.max(0,Math.min(1,recorder.getMaxAmplitude()/32767.0)));return result;
 }
 public synchronized JSONObject stop(){
  if(recorder==null||interrupted)throw new IllegalStateException("No recording is active");
  handler.removeCallbacks(deadline);durationMs=SystemClock.elapsedRealtime()-startedAt;
  try{recorder.stop();}
  catch(RuntimeException error){cancel();throw new IllegalStateException("Recording was too short or unavailable");}
  releaseRecorder();
  if(!file.isFile()||file.length()==0||file.length()>MAX_BYTES){cancel();throw new IllegalStateException("Recording is unavailable or exceeds the size limit");}
  JSONObject result=new JSONObject();put(result,"status","recorded");put(result,"recordingId",id);put(result,"durationMs",durationMs);return result;
 }
 /** Discards an active draft and reports why it must never be transcribed. */
 public synchronized void interrupt(String reason){
  if(recorder==null||interrupted)return;
  final String ownedId=id;
  interrupted=true;
  try{cancel();}
  catch(RuntimeException failure){/* Keep the retired recorder for a later cleanup attempt. */}
  JSONObject result=new JSONObject();
  put(result,"recordingId",ownedId);put(result,"status","failed");put(result,"interrupted",reason);
  events.accept(result);
 }
 /** Finishes a draft at a limit or host pause and reports the outcome as an event. */
 public synchronized void stopAutomatically(){
  if(recorder==null||interrupted)return;
  final String ownedId=id;
  try{events.accept(stop());}
  catch(RuntimeException error){JSONObject result=new JSONObject();put(result,"recordingId",ownedId);put(result,"status","failed");put(result,"message","Recording could not be saved");events.accept(result);}
 }
 /** A new live owner may proceed only after the draft microphone was released.
  * Keep a successfully finalized draft available to its original caller. */
 public synchronized void finishBeforeCapture(){
  stopAutomatically();
  if(recorder!=null)throw new IllegalStateException("Recording microphone cleanup is unconfirmed");
 }
 /**
  * The host's own finished recordings that transcription may also select by id, for example the
  * finished segments of a longer recording the host keeps itself. The source returns null for an
  * id it does not own; a draft with the same id is always chosen first.
  */
 public void selectAlso(Function<String,File> source){also=source;}
 /** The finished draft for {@code recordingId}, or null while recording or after it changed. */
 public synchronized File selected(String recordingId){
  if(interrupted&&id.equals(recordingId))return null;
  if(recorder!=null||file==null||!id.equals(recordingId)){Function<String,File> other=also;return other==null||recordingId==null?null:other.apply(recordingId);}
  return file;
 }
 /** Duration of the finished draft, in milliseconds. */
 public synchronized long durationMs(){return durationMs;}
 public synchronized void discard(String recordingId){if(id!=null&&id.equals(recordingId))cancel();}
 private void releaseRecorder(){
  if(recorder!=null){recorder.release();recorder=null;}
  if(microphone!=null){microphone.release();microphone=null;}
 }
 public synchronized void cancel(){
  try{
   if(deadline!=null)handler.removeCallbacks(deadline);
   if(recorder!=null)try{recorder.stop();}catch(RuntimeException ignored){/* Never started or already stopped. */}
  }finally{
   releaseRecorder();
   if(file!=null)file.delete();file=null;id=null;durationMs=0;interrupted=false;
  }
 }
}
