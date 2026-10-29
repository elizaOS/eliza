package ai.eliza.voice;

import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.res.Configuration;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.util.Arrays;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The foreground on-device speech bridge a product subclasses: private recording drafts, on-device
 * recognition and synthesis on the process-wide inference session, streamed and prepared playback
 * under assistant audio focus, live capture with VAD frame events, and the native voice-turn
 * latency collector. Everything runs on the shared {@code ai.eliza.voice} pipeline.
 *
 * <p>A product subclass supplies its identity and ports:
 * <ul>
 *   <li>{@code @CapacitorPlugin(name=..., permissions=@Permission(alias="microphone", strings=RECORD_AUDIO))}
 *       on the subclass, and the cache prefixes of its recording drafts and prepared clips (its
 *       installed-data identity) through the constructor;
 *   <li>{@link #residentRoute}: the owner-bound transport that carries VAD segments to the resident
 *       agent of the owner who started a live capture ({@code nativeAsr}); without it, segments are
 *       never routed natively and {@code liveCaptureStatus} reports no native transport;
 *   <li>recording storage: {@link #recording()} hands a finished draft to the product's own store;
 *   <li>{@link #launch}: how a permission prompt reaches the activity.
 * </ul>
 * A subclass may add its own bridge methods (for example credential-bound network speech) on
 * {@link #submit}, {@link #publishPreparedAudio} and {@link #synthesizeReviewed}, which share this
 * bridge's single-request admission, cancellation drain and playback.
 *
 * <p>Bridge methods: recording start/stop/cancel/metrics, {@code transcribeLocalRecording},
 * {@code synthesizeLocal}, {@code play}/{@code stopPlayback}, {@code cancel}, live capture status and
 * start/stop with {@code liveCaptureFrames}/{@code liveCaptureEnded}/{@code liveCaptureTranscript}
 * events, {@code localSpeechStatus}/{@code releaseLocalSpeech}, {@code nativeVoiceTiming},
 * {@code markVoiceTurn} and {@code clearNativeVoiceTiming}.
 */
public abstract class LocalSpeechBridgePlugin extends Plugin {
 /** Bounded streamed PCM per utterance: 30 s at 24 kHz (about 2.9 MB of floats), never more. */
 public static final int STREAM_CAPACITY=LocalSpeechEngine.STREAM_RATE*30;
 public static final String CALL_MESSAGE="Speech is paused while a phone call is active";
 /** Fixed answer when the activity can no longer show a prompt. It names no cause as certain. */
 public static final String LAUNCH_CLOSED="Android could not show this request; the app may have closed. Reopen it and try again.";
 private static final int REQUEST_TIMEOUT_MS=120000;

 private final String recordingPrefix,playbackPrefix;
 private LocalVoiceRecording capture;
 private final AtomicLong epoch=new AtomicLong();
 private final Map<String,Long> permissionEpochs=new ConcurrentHashMap<>();
 private final SpeechRequestGate gate=new SpeechRequestGate();
 private final ExecutorService workers=new ThreadPoolExecutor(1,1,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(4));
 private final Handler main=new Handler(Looper.getMainLooper());
 private volatile File playbackFile;
 private String playbackId;
 private String playbackRequestId;
 // The prepared clip is a local spoken reply, and where its first audible sample is.
 private boolean playbackLocalReply;
 private VoiceLatencyTrials.Trial playbackTrial;
 private int playbackLeadIn=-1,playbackFrames,playbackRate;
 private MediaPlayer player;
 private PluginCall preparingPlayback;
 // The streamed local utterance (main thread, like player) and assistant-speech audio focus.
 private StreamingSpeechPlayback streamPlayback;
 private SpeechAudioFocus focus;
 private volatile boolean destroyed;
 private volatile boolean speechForeground=true;
 private final LocalSpeechEngine localEngine=new LocalSpeechEngine(()->SessionSpeech.shared(getContext()));
 private final Object localCancellationGate=new Object();
 private SpeechRequestGate.Request localActiveRequest; // Guarded by localCancellationGate.
 private final AtomicBoolean localReleaseQueued=new AtomicBoolean();
 private final Runnable localIdleRelease=this::queueLocalRelease;
 private final ComponentCallbacks2 localMemoryCallbacks=new ComponentCallbacks2(){
  public void onConfigurationChanged(Configuration value){}
  public void onLowMemory(){releaseForMemoryPressure();}
  public void onTrimMemory(int level){if(level==TRIM_MEMORY_UI_HIDDEN)scheduleLocalRelease(30000);else if(level>=TRIM_MEMORY_RUNNING_LOW)releaseForMemoryPressure();}
 };

 /**
  * @param recordingPrefix cache file prefix of recording drafts (stale drafts are deleted on load)
  * @param playbackPrefix cache file prefix of prepared playback clips (likewise)
  */
 protected LocalSpeechBridgePlugin(String recordingPrefix,String playbackPrefix){
  if(playbackPrefix==null||!playbackPrefix.matches("[a-z][a-z0-9-]{2,63}"))throw new IllegalArgumentException("Invalid playback prefix");
  this.recordingPrefix=recordingPrefix;this.playbackPrefix=playbackPrefix;
 }

 // ---- Product ports -------------------------------------------------------------------------

 /**
  * The owner-bound route of live VAD segments to {@code ownerId}'s resident agent, or null when this
  * product has none. The route must refuse once the owner, runtime or enrollment changed.
  */
 protected LiveCaptureController.Route residentRoute(String ownerId){return null;}
 /** True when {@link #residentRoute} carries segments natively (reported by liveCaptureStatus). */
 protected boolean residentTransport(){return false;}
 /**
  * Runs a request that launches through the activity (a permission prompt). Capacitor can deliver
  * a call after the activity is gone, when the launcher throws IllegalStateException: the call is
  * rejected instead and false returned.
  */
 protected boolean launch(PluginCall call,Runnable request){
  try{request.run();return true;}catch(IllegalStateException closed){call.reject(LAUNCH_CLOSED);return false;}
 }
 /** The private recording drafts, for the product's own storage of a finished draft. */
 protected final LocalVoiceRecording recording(){return capture;}
 protected final boolean destroyed(){return destroyed;}
 protected final Handler mainHandler(){return main;}

 // ---- Lifecycle -----------------------------------------------------------------------------

 @Override public void load(){
  focus=new SpeechAudioFocus(getContext(),main,this::speechFocusChanged);
  focus.watchCalls(main::post,()->main.post(this::callStarted));
  getContext().registerComponentCallbacks(localMemoryCallbacks);
  capture=new LocalVoiceRecording(getContext(),recordingPrefix,value->notifyListeners("recordingStopped",js(value)));
  File[] stale=getContext().getCacheDir().listFiles((dir,name)->name.startsWith(playbackPrefix));
  if(stale!=null)for(File file:stale)file.delete();
 }
 @Override protected void handleOnResume(){speechForeground=true;scheduleLocalRelease(120000);super.handleOnResume();}
 @Override protected void handleOnPause(){speechForeground=false;live.cancelAll();scheduleLocalRelease(30000);if(permissionEpochs.isEmpty())epoch.incrementAndGet();if(capture!=null)capture.stopAutomatically();gate.cancelAll();main.post(this::clearPlayback);super.handleOnPause();}
 @Override protected void handleOnDestroy(){
  destroyed=true;gate.destroy();main.post(()->{if(focus!=null)focus.close();});live.shutdown();livePermissionEpochs.clear();finishDrain(false,"Voice unavailable");epoch.incrementAndGet();permissionEpochs.clear();
  if(capture!=null)capture.cancel();main.post(this::clearPlayback);main.removeCallbacks(localIdleRelease);getContext().unregisterComponentCallbacks(localMemoryCallbacks);
  submitWork(localEngine::close,()->{/* Already stopped: its last task closed nothing new. */});workers.shutdown();super.handleOnDestroy();
 }

 // ---- Helpers -------------------------------------------------------------------------------

 /** Hands work to the serial speech worker; when it is stopped or full, {@code refused} runs instead. */
 private boolean submitWork(Runnable work,Runnable refused){
  try{workers.execute(work);return true;}catch(RejectedExecutionException stopped){refused.run();return false;}
 }
 private static JSObject js(JSONObject value){try{return JSObject.fromJSONObject(value);}catch(JSONException error){throw new IllegalStateException(error);}}
 /** A required bounded string parameter. */
 protected static String required(String value,int max){if(value==null||value.isBlank()||value.length()>max)throw new IllegalArgumentException();return value;}
 /** Reads at most {@code limit} bytes, stopping on cancellation. */
 protected static byte[] read(InputStream in,int limit,SpeechRequestGate.Request request)throws Exception{ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int count;while((count=in.read(buffer))!=-1){if(request.cancelled||out.size()+count>limit)throw new IOException();out.write(buffer,0,count);}return out.toByteArray();}
 /** An HTTP status outside 2xx; the bridge rejects with code {@code voice-http-<status>}. */
 protected static final class SpeechHttpException extends IOException {
  public final int status;
  public SpeechHttpException(int status){super("Voice HTTP request failed");this.status=status;}
 }
 protected static void successful(HttpURLConnection connection)throws Exception{int status=connection.getResponseCode();if(status<200||status>=300)throw new SpeechHttpException(status);}
 private void releaseForMemoryPressure(){gate.cancelAll();queueLocalRelease();}
 private void queueLocalRelease(){
  main.removeCallbacks(localIdleRelease);
  if(!localReleaseQueued.compareAndSet(false,true))return;
  submitWork(()->{try{localEngine.release();}finally{localReleaseQueued.set(false);}},()->localReleaseQueued.set(false));
 }
 private void scheduleLocalRelease(long delay){main.removeCallbacks(localIdleRelease);if(!destroyed)main.postDelayed(localIdleRelease,delay);}

 // ---- Requests ------------------------------------------------------------------------------

 /** One request's work on the serial speech worker. */
 protected interface Work { void run(SpeechRequestGate.Request request)throws Exception; }
 /**
  * Admits one request (by its {@code requestId}) and runs it on the speech worker with a 120 s
  * deadline. The call resolves with {@code request.result} (a JSObject), or rejects with
  * {@code request.failure}/{@code failureCode}; a request that resolved early settles nothing.
  */
 protected final void submit(PluginCall call,Work work){
  final String id;try{id=required(call.getString("requestId"),256);}catch(Exception error){call.reject("Invalid request");return;}
  SpeechRequestGate.Admission admission=gate.admit(id,!Boolean.FALSE.equals(call.getBoolean("replace",true)));
  if(admission.request==null){if(admission.refusal==SpeechRequestGate.Refusal.BUSY)call.reject("Speaker is in use","playback-busy");else call.reject("Voice request already active or unavailable");return;}
  SpeechRequestGate.Request request=admission.request;
  Runnable deadline=request::cancel;request.deadline=deadline;main.postDelayed(deadline,REQUEST_TIMEOUT_MS);
  submitWork(()->{
   try{if(request.cancelled)throw new IOException();work.run(request);}catch(Exception error){request.failure=request.cancelled?"Voice request cancelled":"Voice request failed";if(!request.cancelled&&error instanceof SpeechHttpException)request.failureCode="voice-http-"+((SpeechHttpException)error).status;}
   finally{try{if(request.connection!=null)request.connection.disconnect();}catch(RuntimeException error){request.failure="Voice request cleanup failed";}finally{gate.settle(request);main.removeCallbacks(deadline);}}
   // A continuation may submit immediately when this resolves: release admission first.
   // A streamed utterance resolved at its first chunk; its playback events report the rest.
   if(request.resolvedEarly){/* Settled. */}else if(request.cancelled||destroyed)call.reject("Voice request cancelled");else if(request.failure!=null){if(request.failureCode!=null)call.reject(request.failure,request.failureCode);else call.reject(request.failure);}else if(!(request.result instanceof JSObject))call.reject("Voice request failed");else call.resolve((JSObject)request.result);
  },()->{main.removeCallbacks(deadline);gate.settle(request);call.reject("Voice unavailable");});
 }
 /** Cancels the request {@code requestId} and the playback it prepared (reported as failed). */
 protected final void cancelSpeech(String requestId){SpeechRequestGate.Request request=gate.get(requestId);if(request!=null)request.cancel();if(Objects.equals(playbackRequestId,requestId)){clearPlayback();notifyListeners("playbackFailed",new JSObject());}}
 /** True while a clip, a streamed utterance or a request holds the speaker. */
 protected final boolean speakerBusy(){return playbackFile!=null||streamPlayback!=null||!gate.idle();}
 @PluginMethod public void cancel(PluginCall call){SpeechRequestGate.Request request=gate.get(call.getString("requestId",""));if(request!=null)request.cancel();call.resolve();}

 // ---- Recording drafts ----------------------------------------------------------------------

 @PluginMethod public void startRecording(PluginCall call){
  if(gate.draining()){call.reject("Voice cancellation is still draining");return;}
  if(focus!=null&&focus.callActive()){call.reject(CALL_MESSAGE,SpeechAudioFocusPolicy.CALL_ACTIVE);return;}
  if(getPermissionState("microphone")!=PermissionState.GRANTED){permissionEpochs.put(call.getCallbackId(),epoch.get());if(!launch(call,()->requestPermissionForAlias("microphone",call,"microphonePermission")))permissionEpochs.remove(call.getCallbackId());return;}
  startRecording(call,epoch.get());
 }
 /** Capacitor's own permission request launches through the activity; see {@link #launch}. */
 @Override @PluginMethod public void requestPermissions(PluginCall call){launch(call,()->super.requestPermissions(call));}
 @PermissionCallback private void microphonePermission(PluginCall call){Long admitted=permissionEpochs.remove(call.getCallbackId());if(admitted==null||admitted!=epoch.get()){call.reject("Recording cancelled");return;}if(getPermissionState("microphone")!=PermissionState.GRANTED){call.reject("Microphone permission denied","permission-denied");return;}startRecording(call,admitted);}
 private void startRecording(PluginCall call,long admitted){main.post(()->{if(destroyed||!speechForeground||gate.draining()||admitted!=epoch.get()){call.reject("Recording cancelled");return;}try{int limit=call.getInt("maxDurationMs",LocalVoiceRecording.LONG_LIMIT_MS);if(limit!=LocalVoiceRecording.SHORT_LIMIT_MS&&limit!=LocalVoiceRecording.LONG_LIMIT_MS)throw new IllegalArgumentException("Unsupported capture duration");call.resolve(js(capture.start(limit)));}catch(Exception error){call.reject("Microphone could not start");}});}
 @PluginMethod public void getRecordingMetrics(PluginCall call){main.post(()->{try{call.resolve(js(capture.metrics(call.getString("recordingId"))));}catch(RuntimeException error){call.reject("Recording metrics are no longer available");}});}
 @PluginMethod public void stopRecording(PluginCall call){main.post(()->{try{call.resolve(js(capture.stop()));}catch(Exception error){call.reject("Recording could not be saved");}});}
 private void finishDrain(boolean complete,String error){
  Map<Object,Runnable> released=gate.finishDrain(complete);
  for(Runnable timeout:released.values())main.removeCallbacks(timeout);
  for(Object waiter:released.keySet()){PluginCall call=(PluginCall)waiter;if(error==null)call.resolve();else call.reject(error);}
 }
 /**
  * Discards the draft, cancels every request and resolves once cancelled work and its cleanup have
  * left the serial worker. Admission stays closed until then, even after a waiter times out.
  */
 @PluginMethod public void cancelRecording(PluginCall call){
  epoch.incrementAndGet();permissionEpochs.clear();
  Runnable timeout=()->{if(gate.leaveDrain(call))call.reject("Voice cancellation is still draining");};
  SpeechRequestGate.Drain drain=gate.beginDrain(call,timeout);
  if(drain==SpeechRequestGate.Drain.UNAVAILABLE){call.reject("Voice unavailable");return;}
  main.postDelayed(timeout,REQUEST_TIMEOUT_MS);
  if(drain==SpeechRequestGate.Drain.JOINED)return;
  main.post(()->{
   try{capture.cancel();}catch(RuntimeException error){finishDrain(false,"Recording cancellation failed");return;}
   // Never wait on the UI thread. The serial worker barrier follows cancelled work and its cleanup.
   submitWork(()->main.post(()->finishDrain(true,destroyed?"Voice unavailable":null)),()->finishDrain(false,"Voice cancellation is unavailable"));
  });
 }

 // ---- On-device recognition and synthesis ---------------------------------------------------

 private void submitLocal(PluginCall call,Work work){submit(call,request->{main.removeCallbacks(localIdleRelease);synchronized(localCancellationGate){localActiveRequest=request;request.cancelNative=()->{synchronized(localCancellationGate){if(localActiveRequest==request)localEngine.cancel();}};}try{if(request.cancelled||!speechForeground)throw new IOException("Voice cancelled");work.run(request);}catch(Exception error){if(!keepsEngine(request))localEngine.release();throw error;}catch(LinkageError|OutOfMemoryError error){localEngine.release();throw new IOException("On-device speech unavailable",error);}finally{synchronized(localCancellationGate){if(localActiveRequest==request)localActiveRequest=null;request.cancelNative=null;}if(destroyed||(request.cancelled&&!keepsEngine(request)))localEngine.release();else scheduleLocalRelease(speechForeground?120000:30000);}});}
 /**
  * A cancelled streamed synthesis (barge-in, stop) leaves the models loaded: ParadeeVoice fences the
  * cancelled call by generation, so the next sentence needs no reload. Failures and other
  * cancellations still release them.
  */
 private static boolean keepsEngine(SpeechRequestGate.Request request){return request.keepEngine&&request.cancelled;}
 @PluginMethod public void releaseLocalSpeech(PluginCall call){gate.cancelAll();main.post(this::clearPlayback);queueLocalRelease();call.resolve();}
 // Local CPU execution has no dependency on an account, URL, or host process. The status resolves
 // only when the native pair loads, every bundle file verifies and a context opens. A build without
 // the voice bundle answers "unavailable" without loading any native library.
 @PluginMethod public void localSpeechStatus(PluginCall call){submitLocal(call,request->{
  localEngine.use(engine->{if(request.cancelled||destroyed)throw new IOException();engine.prepare();return null;});
  if(request.cancelled||destroyed)throw new IOException();JSObject out=new JSObject();out.put("ready",true);out.put("execution","device");out.put("provider","fused-paradee-asr");request.result=out;
 });}
 @PluginMethod public void transcribeLocalRecording(PluginCall call){submitLocal(call,request->{
  File file=capture.selected(required(call.getString("recordingId"),256));if(file==null)throw new IOException();byte[] wav=RecordingPcm.decode(file,()->request.cancelled||destroyed);float[] samples;
  try{samples=LocalSpeechEngine.readMono16kWav(wav);}finally{Arrays.fill(wav,(byte)0);}
  String text;try{text=localEngine.use(engine->{if(request.cancelled||destroyed)throw new IOException();return engine.transcribe(samples);});}finally{Arrays.fill(samples,0);}
  if(request.cancelled||destroyed)throw new IOException();JSObject out=new JSObject();out.put("text",text);out.put("local",true);out.put("execution","device");out.put("provider","fused-paradee-asr");request.result=out;
 });}
 @PluginMethod public void synthesizeLocal(PluginCall call){main.post(()->{if(Boolean.FALSE.equals(call.getBoolean("replace",true))&&speakerBusy()){call.reject("Speaker is in use","playback-busy");return;}synthesizeReviewed(call,null);});}
 /**
  * On-device synthesis of {@code reviewed} text the product already approved (for example a read-aloud
  * passage), or of the call's {@code text} (at most 500 characters) when null. Only a reply to a live
  * turn ({@code reviewed==null}) acquires that turn's latency marks. Main thread.
  */
 protected final void synthesizeReviewed(PluginCall call,String reviewed){
  // Never speak over a ringing phone or a call; say so instead of synthesizing.
  if(focus!=null&&focus.callActive()){call.reject(CALL_MESSAGE,SpeechAudioFocusPolicy.CALL_ACTIVE);return;}
  // Bind before the worker queues: only the reply to the named live turn acquires its stage/playback
  // marks; a missing or stale voiceTurnId leaves this utterance unattributed.
  final boolean reply=reviewed==null;
  final VoiceLatencyTrials.Trial trial=reply?VoiceLatencyProbe.TRIALS.forTurn(call.getString("voiceTurnId")):null;
  submitLocal(call,request->{
  String text=reviewed==null?required(call.getString("text"),500):reviewed;byte[] audio;
  int[] clip={-1,0,0};
  int loadsBefore=localEngine.loads();
  if(reply)VoiceLatencyProbe.TRIALS.mark(trial,"tts-start",System.nanoTime());
  // Streaming engines play each chunk as it is synthesized; only an engine without streaming uses the
  // whole-sentence path below. A streaming failure is a failure, never a fallback.
  Boolean streamed=localEngine.use(engine->{if(request.cancelled||destroyed)throw new IOException();if(!engine.supportsStreaming())return false;streamLocal(call,request,engine,text,reply,trial,loadsBefore);return true;});
  if(streamed)return;
  audio=localEngine.use(engine->{if(request.cancelled||destroyed)throw new IOException();if(reviewed!=null)return engine.synthesizePassage(text,()->request.cancelled||destroyed);LocalSpeechEngine.Audio generated=engine.synthesize(text,()->request.cancelled||destroyed);try{clip[0]=VoiceLatencyProbe.leadInFrames(generated.samples);clip[1]=generated.samples.length;clip[2]=generated.sampleRate;return generated.wav();}finally{Arrays.fill(generated.samples,0);}});
  if(reply){VoiceLatencyProbe.TRIALS.mark(trial,"tts-ready",System.nanoTime());if(localEngine.loads()!=loadsBefore)VoiceLatencyProbe.TRIALS.engineLoaded(trial,"tts-load");}
  if(request.cancelled||destroyed){Arrays.fill(audio,(byte)0);throw new IOException();}
  File file=File.createTempFile(playbackPrefix,".wav",getContext().getCacheDir());CountDownLatch completed=new CountDownLatch(1);
  try{try(OutputStream out=new FileOutputStream(file)){out.write(audio);}main.post(()->{try{if(request.cancelled||destroyed){file.delete();request.failure="Voice request cancelled";return;}if(Boolean.FALSE.equals(call.getBoolean("replace",true))&&(playbackFile!=null||streamPlayback!=null)){file.delete();request.failure="Speaker is in use";request.failureCode="playback-busy";return;}clearPlayback();playbackFile=file;playbackRequestId=call.getString("requestId");playbackId=UUID.randomUUID().toString();playbackLocalReply=reply;playbackTrial=trial;playbackLeadIn=clip[0];playbackFrames=clip[1];playbackRate=clip[2];JSObject out=new JSObject();out.put("playbackId",playbackId);out.put("execution","device");request.result=out;}catch(RuntimeException error){request.failure="Playback preparation failed";file.delete();}finally{completed.countDown();}});if(!completed.await(10,TimeUnit.SECONDS)){request.cancel();file.delete();throw new IOException("Playback preparation timed out");}}catch(Exception error){file.delete();throw error;}finally{Arrays.fill(audio,(byte)0);}
 });}
 /**
  * Streamed local speech, on the speech worker inside localEngine.use. The utterance is published
  * (the call resolves with its playbackId) when the first validated chunk arrives; play() then
  * starts an AudioTrack writer. Chunks are held in memory only, in a bounded queue whose
  * backpressure paces synthesis to playback. A failure after publication is reported as playbackFailed.
  */
 private void streamLocal(PluginCall call,SpeechRequestGate.Request request,LocalSpeechEngine.Backend engine,String text,boolean reply,VoiceLatencyTrials.Trial trial,int loadsBefore)throws Exception{
  request.keepEngine=true;
  final String id=UUID.randomUUID().toString();
  final StreamingSpeechPlayback[] self=new StreamingSpeechPlayback[1];
  final StreamingSpeechPlayback playback=new StreamingSpeechPlayback(STREAM_CAPACITY,LocalSpeechEngine.STREAM_RATE,VoiceLatencyProbe.AUDIBLE_LEVEL,()->AudioTrackSpeechOutput.open(LocalSpeechEngine.STREAM_RATE),streamListener(id,reply?trial:null,self),System::nanoTime);
  self[0]=playback;
  // Cancelling the request also wakes a synthesis callback blocked on the full queue.
  final Runnable nativeCancel=request.cancelNative;
  request.cancelNative=()->{playback.stop();if(nativeCancel!=null)nativeCancel.run();};
  final String[] refused={null};
  try{
   engine.synthesizeStream(text,()->request.cancelled||destroyed||playback.stopped(),(samples,complete)->{
    if(request.cancelled||destroyed)return false;
    if(!request.resolvedEarly){
     if(reply){VoiceLatencyProbe.TRIALS.mark(trial,"tts-ready",System.nanoTime());if(localEngine.loads()!=loadsBefore)VoiceLatencyProbe.TRIALS.engineLoaded(trial,"tts-load");}
     refused[0]=publishStream(call,request,playback,id,reply,trial);
     if(refused[0]!=null){Arrays.fill(samples,0);return false;}
    }
    return playback.offer(samples,complete);
   });
  }catch(Exception error){
   if(playback.stopped())request.cancelled=true;
   if(!request.resolvedEarly){playback.stop();if(refused[0]!=null&&settleRefusal(request,refused[0]))return;throw error;}
   main.post(()->{if(streamPlayback==playback){if(request.cancelled)clearPlayback();else playback.fail("synthesis-failed");}else playback.stop();});
   throw error;
  }
  if(!request.resolvedEarly){playback.stop();throw new IllegalStateException("No speech output");}
 }
 private static boolean settleRefusal(SpeechRequestGate.Request request,String refusal){
  if("playback-busy".equals(refusal)){request.failure="Speaker is in use";request.failureCode="playback-busy";request.cancelled=false;return true;}
  return false;
 }
 /** Main-thread publication of a streamed utterance. Null when published, else the refusal. */
 private String publishStream(PluginCall call,SpeechRequestGate.Request request,StreamingSpeechPlayback playback,String id,boolean reply,VoiceLatencyTrials.Trial trial)throws Exception{
  CountDownLatch published=new CountDownLatch(1);String[] refusal={null};
  main.post(()->{try{
   if(request.cancelled||destroyed){refusal[0]="cancelled";return;}
   if(Boolean.FALSE.equals(call.getBoolean("replace",true))&&(playbackFile!=null||streamPlayback!=null)){refusal[0]="playback-busy";return;}
   clearPlayback();streamPlayback=playback;playbackRequestId=call.getString("requestId");playbackId=id;playbackLocalReply=reply;playbackTrial=trial;
   // Synthesis is now paced by playback: the request deadline no longer applies; the queue and writer bound stalls.
   Runnable deadline=request.deadline;if(deadline!=null)main.removeCallbacks(deadline);
   request.resolvedEarly=true;
   JSObject out=new JSObject();out.put("playbackId",id);out.put("execution","device");out.put("streaming",true);call.resolve(out);
  }catch(RuntimeException error){refusal[0]="failed";}finally{published.countDown();}});
  if(!published.await(10,TimeUnit.SECONDS)){request.cancel();return "timeout";}
  return refusal[0];
 }
 private StreamingSpeechPlayback.Listener streamListener(String id,VoiceLatencyTrials.Trial trial,StreamingSpeechPlayback[] self){
  Context app=getContext().getApplicationContext();
  return new StreamingSpeechPlayback.Listener(){
   public void firstFrame(long nanos){if(trial==null)return;VoiceLatencyTrials.Trial owned=VoiceLatencyProbe.TRIALS.firstPcm(trial,nanos);if(owned!=null)VoiceLatencyProbe.stampEnvironment(app,owned);}
   public void audible(long nanos,String clock){if(trial!=null)VoiceLatencyProbe.TRIALS.audible(trial,nanos,clock);}
   public void ended(boolean silent){
    if(trial!=null)VoiceLatencyProbe.TRIALS.failed(trial,silent?"silent-response":"no-audible-time"); // No-op once audible passed it.
    main.post(()->{if(streamPlayback!=self[0])return;clearPlayback(false);JSObject event=new JSObject();event.put("playbackId",id);notifyListeners("playbackEnded",event);});
   }
   public void failed(String reason){
    if(trial!=null)VoiceLatencyProbe.TRIALS.failed(trial,reason);
    main.post(()->{if(streamPlayback!=self[0])return;clearPlayback(false);JSObject event=new JSObject();event.put("playbackId",id);notifyListeners("playbackFailed",event);});
   }
  };
 }

 // ---- Prepared clips and playback -----------------------------------------------------------

 /**
  * Publishes downloaded or generated audio ({@code audio/mpeg} or WAV bytes) as the prepared clip
  * for {@code call}: written to a private cache file, made current on the main thread unless the
  * request was cancelled or the call asked not to replace busy playback. Sets {@code request.result}
  * to the playbackId. Zeroes {@code audio}. Runs on the speech worker.
  */
 protected final void publishPreparedAudio(PluginCall call,SpeechRequestGate.Request request,byte[] audio)throws Exception{
  CountDownLatch completed=new CountDownLatch(1);
  File file=File.createTempFile(playbackPrefix,".audio",getContext().getCacheDir());try{try(FileOutputStream out=new FileOutputStream(file)){out.write(audio);}if(request.cancelled||destroyed)throw new IOException();main.post(()->{try{if(request.cancelled||destroyed){file.delete();request.failure="Voice request cancelled";return;}if(Boolean.FALSE.equals(call.getBoolean("replace",true))&&playbackFile!=null){file.delete();request.failure="Speaker is in use";request.failureCode="playback-busy";return;}clearPlayback();playbackFile=file;playbackRequestId=call.getString("requestId");playbackId=UUID.randomUUID().toString();JSObject value=new JSObject();value.put("playbackId",playbackId);request.result=value;}catch(RuntimeException error){request.failure="Playback preparation failed";file.delete();}finally{completed.countDown();}});completed.await();}catch(Exception error){file.delete();throw error;}finally{Arrays.fill(audio,(byte)0);}
 }
 @PluginMethod public void play(PluginCall call){main.post(()->{try{if(streamPlayback!=null&&Objects.equals(playbackId,call.getString("playbackId"))){playStream(call);return;}if(playbackFile==null||!Objects.equals(playbackId,call.getString("playbackId"))){call.reject("Playback unavailable");return;}if(player!=null){player.release();player=null;}if(preparingPlayback!=null)preparingPlayback.reject("Playback replaced");preparingPlayback=call;MediaPlayer next=new MediaPlayer();player=next;next.setAudioAttributes(SpeechAudioFocus.ATTRIBUTES);next.setDataSource(playbackFile.getAbsolutePath());final String activePlaybackId=playbackId;next.setOnCompletionListener(p->{if(player==p){clearPlayback(false);JSObject event=new JSObject();event.put("playbackId",activePlaybackId);notifyListeners("playbackEnded",event);}});next.setOnErrorListener((p,what,extra)->{if(player==p){clearPlayback(false);JSObject event=new JSObject();event.put("playbackId",activePlaybackId);notifyListeners("playbackFailed",event);}return true;});next.setOnPreparedListener(p->{if(player==p&&!destroyed){try{String refusal=focus.acquire();if(refusal!=null){preparingPlayback=null;clearPlayback();call.reject(refusalMessage(refusal),refusal);return;}p.start();if(playbackLocalReply)VoiceLatencyProbe.playbackStarted(playbackTrial,getContext(),p,main,playbackLeadIn,playbackFrames,playbackRate,()->player==p&&!destroyed);preparingPlayback=null;call.resolve();}catch(RuntimeException error){clearPlayback();}}else call.reject("Playback cancelled");});next.prepareAsync();}catch(Exception error){clearPlayback();call.reject("Playback unavailable");}});}
 private static String refusalMessage(String refusal){return SpeechAudioFocusPolicy.CALL_ACTIVE.equals(refusal)?CALL_MESSAGE:"Another app is using the speaker";}
 /** Starts a published streamed utterance: audio focus first, never during a call. */
 private void playStream(PluginCall call){
  String refusal=focus.acquire();
  if(refusal!=null){clearPlayback();call.reject(refusalMessage(refusal),refusal);return;}
  if(preparingPlayback!=null){preparingPlayback.reject("Playback replaced");preparingPlayback=null;}
  if(player!=null){player.release();player=null;}
  streamPlayback.start();call.resolve();
 }
 /** Focus changes while speech plays (main thread). */
 private void speechFocusChanged(SpeechAudioFocusPolicy.Action action,boolean call){
  switch(action){
   case DUCK:case RESTORE:{boolean ducked=action==SpeechAudioFocusPolicy.Action.DUCK;if(streamPlayback!=null)streamPlayback.duck(ducked);float volume=ducked?SpeechAudioFocusPolicy.DUCK_VOLUME:1f;if(player!=null)try{player.setVolume(volume,volume);}catch(IllegalStateException ignored){/* Released. */}break;}
   case STOP:stopSpeechFor(call?SpeechAudioFocusPolicy.CALL_ACTIVE:"audio-focus-lost");if(call)stopCaptureForCall();break;
   default:break;
  }
 }
 /** Clears unplayed speech and tells the renderer why. */
 private void stopSpeechFor(String reason){String previous=playbackId;if(previous==null)return;clearPlayback(false);JSObject event=new JSObject();event.put("playbackId",previous);event.put("reason",reason);notifyListeners("playbackStopped",event);}
 /** The audio mode entered a call (Android 12+ watcher): stop speech and assistant capture honestly. */
 private void callStarted(){if(destroyed)return;stopSpeechFor(SpeechAudioFocusPolicy.CALL_ACTIVE);stopCaptureForCall();}
 private void stopCaptureForCall(){
  live.interrupt(SpeechAudioFocusPolicy.CALL_ACTIVE);
  if(capture!=null)capture.stopAutomatically();
 }
 private void clearPlayback(){clearPlayback(true);}
 private void clearPlayback(boolean stopped){String previous=playbackId;if(preparingPlayback!=null){preparingPlayback.reject("Playback cancelled");preparingPlayback=null;}if(player!=null){player.release();player=null;}if(streamPlayback!=null){streamPlayback.stop();streamPlayback=null;VoiceLatencyProbe.TRIALS.stopped(playbackTrial);}if(focus!=null)focus.release();if(playbackFile!=null)playbackFile.delete();playbackFile=null;playbackId=null;playbackRequestId=null;playbackLocalReply=false;playbackTrial=null;playbackLeadIn=-1;if(stopped&&previous!=null){JSObject event=new JSObject();event.put("playbackId",previous);notifyListeners("playbackStopped",event);}}
 @PluginMethod public void stopPlayback(PluginCall call){String requestId=call.getString("requestId");main.post(()->{if(requestId==null||Objects.equals(playbackRequestId,requestId))clearPlayback();call.resolve();});}

 // ---- Voice-turn latency --------------------------------------------------------------------

 /** The finished native latency trials (numbers, fixed labels and build/model identity only). */
 @PluginMethod public void nativeVoiceTiming(PluginCall call){
  // Off the live capture worker: the first export may still be hashing the engine.
  Context app=getContext().getApplicationContext();
  Thread export=new Thread(()->{try{call.resolve(JSObject.fromJSONObject(VoiceLatencyProbe.export(app)));}catch(Exception error){call.reject("Voice timing unavailable");}},"speech-timing-export");
  export.setDaemon(true);export.start();
 }
 /**
  * The renderer reports a live turn's final transcript ("asr-final"), agent request dispatch
  * ("request") and first streamed reply token ("first-token"). Stamped with the monotonic clock on
  * arrival (so they include the bridge hop). Without voiceTurnId the stage binds to the open turn
  * and its id is returned; later stages and the reply's synthesizeLocal echo that id.
  */
 @PluginMethod public void markVoiceTurn(PluginCall call){
  long at=System.nanoTime();
  String stage=call.getString("stage","");
  if(!VoiceLatencyTrials.rendererStage(stage)){call.reject("Invalid voice turn stage");return;}
  String turnId=call.getString("voiceTurnId");
  VoiceLatencyTrials.Trial trial=turnId==null?VoiceLatencyProbe.TRIALS.pending():VoiceLatencyProbe.TRIALS.forTurn(turnId);
  JSObject out=new JSObject();out.put("marked",trial!=null&&VoiceLatencyProbe.TRIALS.mark(trial,stage,at));
  if(trial!=null)out.put("voiceTurnId",trial.turnId);
  call.resolve(out);
 }
 @PluginMethod public void clearNativeVoiceTiming(PluginCall call){VoiceLatencyProbe.TRIALS.clear();call.resolve();}

 // ---- Live capture --------------------------------------------------------------------------

 // The shared live capture controller with Silero VAD on the process-wide inference session. One
 // capture at a time. With nativeAsr the VAD segments go to the resident agent of the owner who
 // started the capture (residentRoute), never through the renderer.
 private final LiveCaptureController live=new LiveCaptureController(new LiveCaptureController.Host(){
  public boolean open(long admitted){return !destroyed&&speechForeground&&admitted==epoch.get();}
  public LiveVoiceCapture capture(String id,LiveVoiceCapture.Sink sink,boolean echoCancel)throws Exception{return new LiveVoiceCapture(getContext(),VoiceAssets.sharedInference(getContext()),id,sink,echoCancel);}
  public void frames(String id,JSONArray frames,JSONArray vad,float peak){notifyListeners("liveCaptureFrames",new JSObject().put("captureId",id).put("frames",frames).put("vad",vad).put("peak",peak));}
  public void ended(String id,String error){JSObject event=new JSObject().put("captureId",id);if(error!=null)event.put("error",error);notifyListeners("liveCaptureEnded",event);}
  public void transcript(String id,JSONObject value,String error){JSObject event=new JSObject().put("captureId",id);if(error!=null)event.put("error",error);else event.put("final",value);notifyListeners("liveCaptureTranscript",event);}
 });
 private final Map<String,LiveCaptureAdmission.Ticket> livePermissionEpochs=new ConcurrentHashMap<>();
 @PluginMethod public void liveCaptureStatus(PluginCall call){
  boolean permitted=getPermissionState("microphone")==PermissionState.GRANTED;
  boolean nativeTransport=residentTransport();
  live.onWorker(()->{JSObject result=new JSObject();result.put("permission",permitted);result.put("nativeTransport",nativeTransport);result.put("available",!destroyed&&vadAvailable());call.resolve(result);},()->call.resolve(new JSObject().put("permission",permitted).put("available",false)));
 }
 /** The shared VAD opens on this process's inference session (verifies the bundle once; capture worker only). */
 private boolean vadAvailable(){try{return LiveVoiceCapture.vadAvailable(VoiceAssets.sharedInference(getContext()));}catch(Exception|Error unavailable){return false;}}
 @PluginMethod public void startLiveCapture(PluginCall call){
  String id=call.getString("captureId","");
  if(!id.matches("[0-9a-fA-F-]{36}")){call.reject("Invalid live capture");return;}
  if(gate.draining()||destroyed||!speechForeground){call.reject(LiveCaptureController.CANCELLED);return;}
  if(focus!=null&&focus.callActive()){call.reject("Voice is paused while a phone call is active",SpeechAudioFocusPolicy.CALL_ACTIVE);return;}
  LiveCaptureAdmission.Ticket ticket=live.reserve(id,epoch.get());
  if(getPermissionState("microphone")!=PermissionState.GRANTED){livePermissionEpochs.put(call.getCallbackId(),ticket);if(!launch(call,()->requestPermissionForAlias("microphone",call,"liveMicrophonePermission")))livePermissionEpochs.remove(call.getCallbackId());return;}
  startLive(call,ticket);
 }
 @PermissionCallback private void liveMicrophonePermission(PluginCall call){LiveCaptureAdmission.Ticket ticket=livePermissionEpochs.remove(call.getCallbackId());if(ticket==null||!live.current(ticket)||ticket.epoch!=epoch.get()){call.reject(LiveCaptureController.CANCELLED);return;}if(getPermissionState("microphone")!=PermissionState.GRANTED){call.reject("Microphone permission denied","permission-denied");return;}startLive(call,ticket);}
 private void startLive(PluginCall call,LiveCaptureAdmission.Ticket ticket){
  String owner=call.getString("ownerId","");
  LiveCaptureController.Route route=Boolean.TRUE.equals(call.getBoolean("nativeAsr",false))?residentRoute(owner):null;
  live.start(ticket,Boolean.TRUE.equals(call.getBoolean("echoCancel",false)),route,call.getString("roomId",null),new LiveCaptureController.Started(){
   public void started(String id,int sampleRate,boolean echoCancelled,boolean piped){call.resolve(new JSObject().put("captureId",id).put("sampleRate",sampleRate).put("echoCancelled",echoCancelled).put("nativeAsr",piped));}
   public void refused(String message,String code){if(code==null)call.reject(message);else call.reject(message,code);}
  });
 }
 @PluginMethod public void stopLiveCapture(PluginCall call){
  live.stop(call.getString("captureId",""),Boolean.TRUE.equals(call.getBoolean("discard",false)),call.getData().optDouble("cutoffMs",System.currentTimeMillis()),
   (id,duration,serverClosed)->call.resolve(new JSObject().put("captureId",id).put("durationMs",duration).put("serverClosed",serverClosed)));
 }
}
