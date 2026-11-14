package ai.eliza.voice;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import ai.eliza.voice.AudioTrackSpeechOutput;
import ai.eliza.voice.SpeechAudioFocus;
import ai.eliza.voice.SpeechAudioFocusPolicy;
import ai.eliza.voice.StreamingSpeechPlayback;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import okhttp3.*;
import okio.ByteString;
import org.json.JSONObject;

/** Native speech-only Cloud relay. A product supplies credential authority and the reviewed origin. */
public abstract class SpeechStreamBridgePlugin extends Plugin {

 /** Products expose only a fixed Cloud origin, never a renderer-supplied destination. */
 protected abstract String cloudOrigin(String environment)throws Exception;
 /** Read one selected credential under the product authority lock; never return it to JavaScript. */
 protected abstract Credential readCredential(String environment,String expectedId,long epoch)throws Exception;
 protected abstract long authorityEpoch();
 protected static final class Credential {public final String token;public final long expiresAt;public Credential(String token,long expiresAt){this.token=token;this.expiresAt=expiresAt;}}
 protected boolean launch(PluginCall call,Runnable action){try{action.run();return true;}catch(IllegalStateException unavailable){call.reject("Activity unavailable");return false;}}
 private static boolean submit(java.util.concurrent.Executor executor,Runnable action,Runnable rejected){try{executor.execute(action);return true;}catch(RejectedExecutionException stopped){rejected.run();return false;}}
 protected String diagnosticFormat(){return "eliza-cloud-stream-timing-v1";}
 /** A product that reads Cloud plan limits returns the sanitized retry facts of an HTTP 429 (header and bounded body); the body never reaches JavaScript. */
 protected JSObject limitData(int status,String retryAfter,String body){return null;}
 private static final MediaType JSON=MediaType.get("application/json; charset=utf-8");
 private static final String BASE="/api/v1/voice/speech/";
 private static final long HTTP_STARTUP_MS=12_000,RELAY_STARTUP_MS=8_000;
 /** PCM held between the socket reader and the speaker, at most one utterance's output bound. */
 private static final long FEED_BYTES=8*1024*1024;
 private static final int FEED_TASKS=1024;
 private final Handler main=new Handler(Looper.getMainLooper());
 private final ExecutorService control=Executors.newSingleThreadExecutor();
 private final ExecutorService media=Executors.newSingleThreadExecutor();
 // OkHttp WebSockets use HTTP/1.1. Keep bootstrap on the same protocol so the upgrade can reuse its connection.
 private final OkHttpClient http=new OkHttpClient.Builder().protocols(java.util.Collections.singletonList(Protocol.HTTP_1_1)).connectTimeout(8,TimeUnit.SECONDS).readTimeout(10,TimeUnit.SECONDS).writeTimeout(5,TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build();
 private volatile Session session;
 private volatile boolean foreground=true,destroyed;
 private SpeechAudioFocus focus;
 private volatile PluginCall pendingStart;
 private final java.util.ArrayDeque<JSObject> timings=new java.util.ArrayDeque<>();
 private long timingSequence;
 private void mark(Session own,String stage){markAt(own,stage,System.nanoTime(),null,0);}
 private synchronized void markAt(Session own,String stage,long nanos,String clock,long utteranceStarted){
  JSObject row=new JSObject();row.put("session",own.diagnosticId);row.put("stage",stage);row.put("elapsedMs",Math.max(0,(nanos-own.started)/1_000_000));
  if(utteranceStarted>0)row.put("utteranceElapsedMs",Math.max(0,(nanos-utteranceStarted)/1_000_000));
  if(StreamingSpeechPlayback.TIMESTAMP_CLOCK.equals(clock)||StreamingSpeechPlayback.HEAD_CLOCK.equals(clock))row.put("clock",clock);
  else row.put("clock","monotonic-observed");
  row.put("sentFrames",own.sentFrames);row.put("sentBytes",own.sentBytes);row.put("receivedFrames",own.receivedFrames);row.put("receivedBytes",own.receivedBytes);if(own.httpStatus!=0)row.put("httpStatus",own.httpStatus);timings.addLast(row);while(timings.size()>100)timings.removeFirst();
 }
 @PluginMethod public synchronized void cloudStreamTiming(PluginCall call){JSArray rows=new JSArray();for(JSObject row:timings)rows.put(row);call.resolve(new JSObject().put("format",diagnosticFormat()).put("records",rows));}

 @Override public void load(){
  focus=new SpeechAudioFocus(getContext(),main,(action,call)->{
   Session own=session;if(own==null)return;
   if(action==SpeechAudioFocusPolicy.Action.DUCK||action==SpeechAudioFocusPolicy.Action.RESTORE){Utterance spoken=own.spoken;if(spoken!=null&&spoken.playback!=null)spoken.playback.duck(action==SpeechAudioFocusPolicy.Action.DUCK);}
   else if(action==SpeechAudioFocusPolicy.Action.STOP)retire(own,call?"call-active":"audio-focus-lost");
  });
  focus.watchCalls(main::post,()->{Session own=session;if(own!=null)retire(own,"call-active");});
 }
 @Override @PluginMethod public void requestPermissions(PluginCall call){launch(call,()->super.requestPermissions(call));}
 @PluginMethod public void startCloudSpeech(PluginCall call){
  if(destroyed||!foreground||sensitiveSurfaceActive()){call.reject("Voice is not in the foreground");return;}
  final boolean permission=getPermissionState("microphone")!=PermissionState.GRANTED;
  synchronized(this){if(session!=null||pendingStart!=null||destroyed||!foreground){call.reject("Voice is already active or unavailable");return;}pendingStart=call;}
  if(permission){if(!launch(call,()->requestPermissionForAlias("microphone",call,"microphoneReady"))){synchronized(this){if(pendingStart==call)pendingStart=null;}}return;}
  start(call);
 }
 @PermissionCallback private void microphoneReady(PluginCall call){
  synchronized(this){if(pendingStart!=call)return;if(getPermissionState("microphone")!=PermissionState.GRANTED){pendingStart=null;call.reject("Microphone permission denied","permission-denied");return;}}
  // Keep this owner through the authority lookup; only publication or cancellation clears it.
  main.post(()->{synchronized(this){if(pendingStart!=call)return;if(destroyed||!foreground){pendingStart=null;call.reject("Voice is not in the foreground");return;}}start(call);});
 }
 private void start(PluginCall call){
  final String id=call.getString("sessionId"),environment=call.getString("environment"),credential=call.getString("credentialId");
  try{UUID.fromString(id);if(credential==null||credential.length()>128)throw new IllegalArgumentException();}catch(Exception invalid){synchronized(this){if(pendingStart!=call)return;pendingStart=null;}call.reject("Invalid speech session");return;}
  // Product authority can take lifecycle/vault locks. Never hold this monitor across that lookup.
  final long admittedEpoch;
  try{admittedEpoch=authorityEpoch();}catch(RuntimeException unavailable){synchronized(this){if(pendingStart!=call)return;pendingStart=null;}call.reject("Cloud account unavailable");return;}
  final Session own;
  synchronized(this){
   if(pendingStart!=call)return;
   pendingStart=null;
   if(session!=null||destroyed||!foreground){call.reject("Voice is already active or unavailable");return;}
   own=new Session(id,environment,credential,admittedEpoch,call);
   session=own;
  }mark(own,"start");own.scheduleStartupDeadline();
  submit(control,()->{try{
   own.check();if(focus.callActive())throw new IOException("call-active");
   own.origin=cloudOrigin(environment);
   java.net.URI origin=new java.net.URI(own.origin);
   if(!"https".equals(origin.getScheme())||origin.getHost()==null||origin.getRawUserInfo()!=null||origin.getRawQuery()!=null||origin.getRawFragment()!=null||origin.getRawPath()!=null&&!origin.getRawPath().isEmpty()||origin.getPort()!=-1&&origin.getPort()!=443)throw new SecurityException("Invalid Cloud origin");
   Credential binding=readCredential(environment,credential,own.epoch);own.token=binding.token;
   if(binding.expiresAt<=System.currentTimeMillis()||own.token==null||own.token.isEmpty()||own.token.length()>16384||own.token.contains("\r")||own.token.contains("\n"))throw new SecurityException("Cloud account unavailable");
   JSONObject consent=post(own,"consent",new JSONObject());mark(own,"consent");String nonce=consent.getString("consentNonce");UUID.fromString(nonce);
   if(Instant.parse(consent.getString("expiresAt")).toEpochMilli()<=System.currentTimeMillis())throw new IOException("Expired consent");
   JSONObject minted=post(own,"session",new JSONObject().put("consentNonce",nonce));mark(own,"mint");
   own.serverId=minted.getString("sessionId");UUID.fromString(own.serverId);
   own.expiresAt=Instant.parse(minted.getString("expiresAt")).toEpochMilli();
   if(minted.getInt("version")!=1||own.expiresAt<=System.currentTimeMillis()||own.expiresAt>System.currentTimeMillis()+CloudSpeechWire.MAX_WINDOW_MS)throw new IOException("Invalid session expiry");
   String address=minted.getString("wsUrl"),expected=own.origin.replaceFirst("^https:","wss:")+BASE+"ws?sessionId="+own.serverId;
   if(!expected.equals(address))throw new IOException("Invalid speech destination");
   own.wireToken=minted.getString("token");if(own.wireToken.isEmpty()||own.wireToken.length()>6144)throw new IOException("Invalid speech token");
   own.armRelayStartup();own.check();mark(own,"relay-start");
   WebSocket socket=http.newWebSocket(new Request.Builder().url(address).build(),new RelayListener(own));
   own.socket=socket;if(own.closed.get())socket.cancel();
  }catch(Exception failure){if(failure instanceof CloudHttpFailure){CloudHttpFailure refused=(CloudHttpFailure)failure;fail(own,refused.code(),refused.data);}else fail(own,failure instanceof java.net.UnknownHostException?"dns":failure instanceof java.net.SocketTimeoutException?"timeout":failure instanceof javax.net.ssl.SSLException?"tls":"connect");}},()->fail(own,"closed"));
 }
 /** The batch route's voice-http-<status>, except 404: cloud-http-404 is the renderer's one batch fallback signal. */
 private static final class CloudHttpFailure extends IOException {final int status;final JSObject data;CloudHttpFailure(int status,JSObject data){super("Cloud speech HTTP refused");this.status=status;this.data=data;}String code(){return (status==404?"cloud-http-":"voice-http-")+status;}}
 private CloudHttpFailure refused(Response response){
  int status=response.code();if(status!=429)return new CloudHttpFailure(status,null);String body=null;
  try{ResponseBody bytes=response.body();if(bytes!=null)try(java.io.InputStream in=bytes.byteStream()){java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();byte[] chunk=new byte[4096];int n;while((n=in.read(chunk))!=-1){if(out.size()+n>16384)throw new IOException("Oversized refusal");out.write(chunk,0,n);}body=out.toString(StandardCharsets.UTF_8.name());}}catch(Exception ignored){/* An absent, oversized or unreadable body leaves only Retry-After. */}
  JSObject data;try{data=limitData(status,response.header("Retry-After"),body);}catch(RuntimeException ignored){data=null;}
  return new CloudHttpFailure(status,data);
 }
 private JSONObject post(Session own,String path,JSONObject body)throws Exception{
  own.check();mark(own,path+"-start");Request request=new Request.Builder().url(own.origin+BASE+path).header("Authorization","Bearer "+own.token).post(RequestBody.create(body.toString(),JSON)).build();
  Call pending=http.newCall(request);own.pending=pending;
  try{
   own.check();
   try(Response response=pending.execute()){
    own.check();own.httpStatus=response.code();mark(own,path+"-headers");if(!response.isSuccessful())throw refused(response);if("session".equals(path))own.extendOffered=CloudSpeechWire.EXTEND_OFFER.equals(response.header(CloudSpeechWire.EXTEND_HEADER));ResponseBody bytes=response.body();if(bytes==null||bytes.contentLength()>32768)throw new IOException("Invalid speech response");
    try(java.io.InputStream in=bytes.byteStream()){java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();byte[] chunk=new byte[4096];int n;while((n=in.read(chunk))!=-1){if(out.size()+n>32768)throw new IOException("Oversized speech response");out.write(chunk,0,n);}mark(own,path+"-body");return new JSONObject(out.toString(StandardCharsets.UTF_8.name()));}
   }
  }finally{own.pending=null;}
 }
 @PluginMethod public void stopCloudSpeech(PluginCall call){
  final PluginCall waiting;final Session own;
  synchronized(this){PluginCall pending=pendingStart;waiting=pending!=null&&String.valueOf(call.getString("sessionId")).equals(pending.getString("sessionId"))?pending:null;if(waiting!=null)pendingStart=null;own=owned(call);}
  if(waiting!=null)waiting.reject("Cloud streaming speech stopped","cancelled");
  if(own==null){call.resolve();return;}detach(own);queueCleanup(own,call::resolve);}
 @PluginMethod public void setCloudSpeechMuted(PluginCall call){
  Session own=owned(call);if(own==null){call.reject("Speech session changed");return;}
  boolean muted=Boolean.TRUE.equals(call.getBoolean("muted",false));own.muted=muted;long mute=++own.muteGeneration;if(muted)silence(own,mute,30);
  submit(media,()->{try{own.check();if(mute==own.muteGeneration){if(muted)stopCapture(own);else if(own.recorder==null)own.startCapture();}call.resolve();}catch(Exception failure){call.reject("Microphone could not change state");fail(own,"capture");}},()->call.reject("Voice is closed"));
 }
 @PluginMethod public void speakCloudSpeech(PluginCall call){
  Session own=owned(call);String id=call.getString("utteranceId"),text=call.getString("text");
  if(own==null||own.speakerDraining||!own.providerReady||!CloudSpeechWire.id(id)||text==null||text.trim().isEmpty()||text.length()>4096){call.reject("Invalid speech request");return;}
  main.post(()->{try{
   own.check();if(own.spoken!=null||own.speakerDraining)throw new IllegalStateException("Speaker is already active");String refused=focus.acquire();if(refused!=null)throw new IllegalStateException(refused);
   java.util.List<String> phrases=CloudSpeechWire.phrases(text);Utterance utterance=new Utterance(own,id);own.spoken=utterance;mark(own,"tts-request");
   for(String phrase:phrases)own.send(new JSONObject().put("t","tts").put("id",id).put("text",phrase).put("flush",true));
   own.send(new JSONObject().put("t","finish").put("id",id));call.resolve();
  }catch(Exception failure){cancelSpeech(own,id);call.reject("Speech could not start");}});
 }
 @PluginMethod public void cancelCloudSpeech(PluginCall call){main.post(()->{
  Session own=owned(call);Utterance retired=own==null?null:cancelSpeech(own,call.getString("utteranceId"));
  if(retired==null){call.resolve();return;}
  submit(media,()->{try{if(retired.playback!=null&&!retired.playback.join(1500)){call.reject("Speech cleanup was not confirmed","speech-cleanup-unconfirmed");fail(own,"playback");return;}own.speakerDraining=false;call.resolve();}catch(InterruptedException failure){Thread.currentThread().interrupt();call.reject("Speech cleanup was not confirmed","speech-cleanup-unconfirmed");}},()->call.reject("Speech cleanup was not confirmed","speech-cleanup-unconfirmed"));
 });}
 private Session owned(PluginCall call){Session own=session;return own!=null&&own.id.equals(call.getString("sessionId"))?own:null;}
 private Utterance cancelSpeech(Session own,String id){
  Utterance value=own.spoken;if(value==null||id!=null&&!value.id.equals(id))return null;
  synchronized(value){if(own.spoken!=value)return null;own.spoken=null;own.speakerDraining=value.playback!=null;value.cancelled=true;}
  if(value.playback!=null)value.playback.stop();
  try{own.send(new JSONObject().put("t","cancel").put("id",value.id));}catch(Exception ignored){}
  main.post(()->{if(session==null||session==own)focus.release();});return value;
 }
 private static String preReadyError(JSONObject row)throws IOException{
  Object code=row.opt("code");boolean hasReason=row.has("reason");
  boolean known="unauthorized".equals(code)||"protocol".equals(code)||"unavailable".equals(code)||"closed".equals(code);
  if(!known||row.length()!=(hasReason?3:2)||
    hasReason&&(!"unavailable".equals(code)||!"insufficient_credits".equals(row.opt("reason"))))throw new IOException("Invalid speech startup error");
  return hasReason?"insufficient_credits":(String)code;
 }
 private final class RelayListener extends WebSocketListener {
  final Session own;RelayListener(Session own){this.own=own;}
  @Override public void onOpen(WebSocket socket,Response response){try{own.socket=socket;own.check();mark(own,"ws-open");JSONObject hello=new JSONObject().put("t","hello").put("token",own.wireToken).put("errorReasons",true);
   // A relay that predates renewal refuses an unknown hello key: ask only when the mint offered it.
   if(own.extendOffered)hello.put("extend",true);own.send(hello);own.wireToken=null;}catch(Exception error){fail(own,"connect");}}
  @Override public void onMessage(WebSocket socket,String text){
   try{own.check();if(text.getBytes(StandardCharsets.UTF_8).length>8192)throw new IOException("Oversized speech control");JSONObject row=new JSONObject(text);String type=row.getString("t");
    if("ready".equals(type)){if(own.ready||row.getInt("version")!=1||row.getInt("sampleRate")!=16000||row.getInt("channels")!=1)throw new IOException("Invalid speech format");own.ready=true;mark(own,"ready");arm(own);return;}
    if(!own.ready){
     if("error".equals(type)){fail(own,preReadyError(row));return;}
     throw new IOException("Speech is not ready");
    }
    if("extended".equals(type)){if(!own.extendOffered)throw new IOException("Unrequested renewal");own.expiresAt=CloudSpeechWire.renewal(row.getString("expiresAt"),own.expiresAt,System.currentTimeMillis());mark(own,"extended");arm(own);return;}
    if("stt".equals(type)){JSONObject data=row.getJSONObject("event");String event=data.getString("type");if("connected".equals(event)){if(own.providerReady)return;own.providerReady=true;mark(own,"stt-connected");submit(media,()->{try{own.startCapture();main.removeCallbacks(own.deadline);}catch(Exception failed){fail(own,"capture");}},()->fail(own,"closed"));return;}String transcript=data.optString("transcript","");if(transcript.length()>16384)throw new IOException("Transcript too large");
     if("start-of-turn".equals(event)||"turn-resumed".equals(event)){mark(own,"speech-start");emit(own,"speech-start",new JSObject());}
     else if("end-of-turn".equals(event)){mark(own,"asr-final");emit(own,"speech-end",new JSObject().put("text",transcript).put("final",true));}
     else if("transcript-update".equals(event)||"eager-end-of-turn".equals(event))emit(own,"transcript",new JSObject().put("text",transcript).put("final",false));
     else throw new IOException("Invalid recognition event");
    }else if("complete".equals(type)){Utterance u=own.spoken;if(u!=null&&u.id.equals(row.optString("id"))&&!u.cancelled){if(u.playback==null||u.finished)throw new IOException("Speech completed without audio");u.finished=true;feed(own,u,null);}}
    else if("error".equals(type))fail(own,"unavailable");
    else if(!"tts_prepared".equals(type)&&!"flush_complete".equals(type))throw new IOException("Invalid speech event");
   }catch(Exception error){fail(own,"protocol");}
  }
  @Override public void onMessage(WebSocket socket,ByteString bytes){
   try{own.check();CloudSpeechWire.Audio frame=CloudSpeechWire.decode(bytes.toByteArray());Utterance u=own.spoken;if(u==null||u.cancelled||!u.id.equals(frame.id))return;if(u.finished||u.receivedBytes+frame.pcm.length>FEED_BYTES)throw new IOException("Invalid speech output");
    synchronized(u){if(u.cancelled||own.spoken!=u)return;if(u.playback==null){u.playback=new StreamingSpeechPlayback(16000*5,16000,0.005f,()->AudioTrackSpeechOutput.open(16000),new StreamingSpeechPlayback.Listener(){
     public void firstFrame(long nanos){markAt(own,"first-pcm",nanos,null,u.started);emit(own,"audio-start",new JSObject().put("utteranceId",u.id).put("elapsedMs",(nanos-u.started)/1_000_000));}
     public void audible(long nanos,String clock){u.audible=nanos;markAt(own,"first-audible",nanos,clock,u.started);}
     public void ended(boolean silent){if(own.spoken!=u||u.cancelled)return;own.spoken=null;mark(own,"audio-end");main.post(()->{if(session==null||session==own)focus.release();});emit(own,"audio-end",new JSObject().put("utteranceId",u.id).put("silent",silent));}
     public void failed(String reason){if(own.spoken==u&&!u.cancelled)fail(own,"playback");}
    },System::nanoTime);u.playback.start();}}
    own.receivedFrames++;own.receivedBytes+=frame.pcm.length;u.receivedBytes+=frame.pcm.length;feed(own,u,frame.pcm);
   }catch(Exception error){fail(own,"playback");}
  }
  @Override public void onFailure(WebSocket socket,Throwable error,Response response){fail(own,"connection-lost");}
  @Override public void onClosed(WebSocket socket,int code,String reason){if(!own.closed.get())fail(own,"connection-lost");}
 }
 /**
  * Hands PCM (or, with null, the utterance's completion) to the session's feeder, in arrival order, so
  * a full playback queue never parks OkHttp's one reader thread and the recognition frames behind it.
  * Held PCM is bounded by bytes: a stalled speaker fails the session instead of growing memory.
  */
 private void feed(Session own,Utterance u,byte[] pcm){
  long size=pcm==null?0:pcm.length;
  Runnable release=()->{if(pcm!=null)Arrays.fill(pcm,(byte)0);own.feeding.addAndGet(-size);};
  if(own.feeding.addAndGet(size)>FEED_BYTES){release.run();fail(own,"playback");return;}
  submit(own.feeder,()->{float[] samples=null;try{
   if(own.closed.get()||u.cancelled||own.spoken!=u)return;
   boolean offered;
   if(pcm==null)offered=u.playback.offer(null,true);
   else{samples=CloudSpeechWire.floats(pcm);offered=true;for(int start=0;offered&&start<samples.length;start+=1600)offered=u.playback.offer(Arrays.copyOfRange(samples,start,Math.min(samples.length,start+1600)),false);}
   // A cancelled or replaced utterance stops its playback; that refusal is the cancel, not a failure.
   if(!offered&&!u.cancelled&&own.spoken==u)fail(own,"playback");
  }catch(InterruptedException interrupted){Thread.currentThread().interrupt();}catch(RuntimeException failure){if(!u.cancelled&&own.spoken==u)fail(own,"playback");}finally{if(samples!=null)Arrays.fill(samples,0f);release.run();}},()->{release.run();if(!own.closed.get()&&!u.cancelled&&own.spoken==u)fail(own,"playback");});
 }
 /** One cancellable expiry per session: an accepted renewal moves it, and detach removes it. */
 private void arm(Session own){main.removeCallbacks(own.expiry);if(!own.closed.get())main.postDelayed(own.expiry,Math.max(1,own.expiresAt-System.currentTimeMillis()));}
 private final class Session {
  final String id,environment,credential;final long epoch,started=System.nanoTime(),diagnosticId=++timingSequence;final PluginCall startCall;final AtomicBoolean closed=new AtomicBoolean(),startSettled=new AtomicBoolean();
  volatile String origin,token,wireToken,serverId;volatile long expiresAt,sentFrames,sentBytes,receivedFrames,receivedBytes;volatile int httpStatus;volatile boolean ready,providerReady,muted,speakerDraining,extendOffered;volatile long muteGeneration;volatile Call pending;volatile WebSocket socket;volatile AudioRecord recorder;volatile AcousticEchoCanceler echo;volatile Thread capture;volatile Utterance spoken;
  final long startupStartedMs=SystemClock.elapsedRealtime();
  volatile long startupEndsMs=startupStartedMs+HTTP_STARTUP_MS;
  final Runnable deadline=this::expireStartup;
  synchronized void scheduleStartupDeadline(){
   main.removeCallbacks(deadline);
   if(!closed.get())main.postDelayed(deadline,Math.max(0,startupEndsMs-SystemClock.elapsedRealtime()));
   if(closed.get())main.removeCallbacks(deadline);
  }
  synchronized void armRelayStartup()throws IOException{
   check();long now=SystemClock.elapsedRealtime(),leaseMs=expiresAt-System.currentTimeMillis();
   if(now>=startupEndsMs||leaseMs<=0)throw new java.net.SocketTimeoutException("Speech startup window expired");
   // Mint must complete on time. Relay startup is then bounded by both phase and session expiry.
   startupEndsMs=Math.min(startupStartedMs+HTTP_STARTUP_MS+RELAY_STARTUP_MS,now+Math.min(RELAY_STARTUP_MS,leaseMs));
   scheduleStartupDeadline();
  }
  synchronized void expireStartup(){
   if(closed.get()||startSettled.get())return;
   if(SystemClock.elapsedRealtime()<startupEndsMs)scheduleStartupDeadline();
   else fail(this,"startup-timeout");
  }
  final Runnable expiry=()->retire(this,"expired");
  final ExecutorService feeder=new ThreadPoolExecutor(1,1,0L,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(FEED_TASKS),work->{Thread thread=new Thread(work,"eliza-cloud-speech-feeder");thread.setDaemon(true);return thread;},new ThreadPoolExecutor.AbortPolicy());final AtomicLong feeding=new AtomicLong();
  Session(String id,String environment,String credential,long epoch,PluginCall call){this.id=id;this.environment=environment;this.credential=credential;this.epoch=epoch;this.startCall=call;}
  void check()throws IOException{if(closed.get()||session!=this||destroyed||!foreground||epoch!=authorityEpoch()||sensitiveSurfaceActive())throw new IOException("Speech session changed");if(!startSettled.get()&&SystemClock.elapsedRealtime()>=startupEndsMs)throw new java.net.SocketTimeoutException("Speech startup window expired");}
  void send(JSONObject value)throws IOException{check();WebSocket peer=socket;if(peer==null||peer.queueSize()>64000||!peer.send(value.toString()))throw new IOException("Speech transport unavailable");}
  void startCapture()throws Exception{
   check();if(getContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)throw new SecurityException("Microphone permission denied");
   int minimum=AudioRecord.getMinBufferSize(16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT);if(minimum<=0)throw new IOException("Capture unavailable");
   boolean cancel=AcousticEchoCanceler.isAvailable();AudioRecord next=new AudioRecord.Builder().setAudioSource(cancel?MediaRecorder.AudioSource.VOICE_COMMUNICATION:MediaRecorder.AudioSource.VOICE_RECOGNITION).setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build()).setBufferSizeInBytes(Math.max(minimum,6400)).build();
   recorder=next;if(next.getState()!=AudioRecord.STATE_INITIALIZED)throw new IOException("Capture unavailable");if(cancel){echo=AcousticEchoCanceler.create(next.getAudioSessionId());if(echo!=null)echo.setEnabled(true);}boolean echoEnabled=echo!=null&&echo.getEnabled();
   check();next.startRecording();if(next.getRecordingState()!=AudioRecord.RECORDSTATE_RECORDING)throw new IOException("Capture unavailable");
   capture=new Thread(()->{byte[] frame=new byte[1024];long levelAt=0;try{while(!closed.get()&&!muted&&recorder==next){check();int count=next.read(frame,0,frame.length,AudioRecord.READ_BLOCKING);if(count<=0||count%2!=0)throw new IOException("Microphone stopped");long now=System.nanoTime();if(now-levelAt>50_000_000L){levelAt=now;emit(this,"level",new JSObject().put("peak",muted?0:CloudSpeechWire.peak(frame,count)));}if(!muted){check();WebSocket peer=socket;if(peer==null||peer.queueSize()>64000||!peer.send(ByteString.of(frame,0,count)))throw new IOException("Speech upload stalled");sentFrames++;sentBytes+=count;}}}catch(Exception error){if(!closed.get()&&!muted&&recorder==next)fail(this,"capture");}finally{Arrays.fill(frame,(byte)0);}},"eliza-cloud-speech-microphone");capture.setDaemon(true);capture.start();
   synchronized(this){check();emit(this,"ready",new JSObject().put("sampleRate",16000).put("echoCancelled",echoEnabled));if(startSettled.compareAndSet(false,true))startCall.resolve(new JSObject().put("sessionId",id).put("sampleRate",16000).put("echoCancelled",echoEnabled));}
  }
 }
 private static final class Utterance {final String id;final long started=System.nanoTime();volatile boolean cancelled,finished;volatile long audible,receivedBytes;volatile StreamingSpeechPlayback playback;Utterance(Session own,String id){this.id=id;}}
 private void emit(Session own,String type,JSObject detail){if(own.closed.get()||session!=own)return;detail.put("sessionId",own.id);detail.put("type",type);notifyListeners("cloudSpeechEvent",detail);}
 private void fail(Session own,String code){fail(own,code,null);}
 private void fail(Session own,String code,JSObject data){if(own.closed.get())return;mark(own,"error");JSObject event=new JSObject().put("code",code).put("status",own.httpStatus);if(data!=null)event.put("data",data);emit(own,"error",event);if(own.startSettled.compareAndSet(false,true))own.startCall.reject("Cloud streaming speech is unavailable",code,data);retire(own,null);}
 private void retire(Session own,String reason){if(reason!=null)emit(own,"error",new JSObject().put("code",reason));detach(own);queueCleanup(own,()->{});}
 private void detach(Session own){if(!own.closed.compareAndSet(false,true))return;mark(own,"stop");synchronized(this){if(session==own)session=null;}main.removeCallbacks(own.deadline);main.removeCallbacks(own.expiry);Call call=own.pending;if(call!=null)call.cancel();WebSocket socket=own.socket;if(socket!=null)socket.cancel();if(own.startSettled.compareAndSet(false,true))own.startCall.reject("Cloud streaming speech stopped","cancelled");Utterance u=own.spoken;if(u!=null){synchronized(u){u.cancelled=true;}if(u.playback!=null)u.playback.stop();}own.feeder.shutdown();main.post(()->{if(session==null||session==own)focus.release();});}
 /** A bounded silence tail closes Ink's current turn after the physical mic stops. */
 private void silence(Session own,long generation,int remaining){
  if(remaining<=0||!own.muted||own.muteGeneration!=generation||own.closed.get())return;
  try{own.check();WebSocket socket=own.socket;if(socket==null||socket.queueSize()>64000||!socket.send(ByteString.of(new byte[1024])))throw new IOException();own.sentFrames++;own.sentBytes+=1024;}catch(Exception ignored){return;}
  main.postDelayed(()->silence(own,generation,remaining-1),32);
 }
 /** Host-native retirement; does not gate the old session's captured-token cleanup. */
 protected final void retireSpeechAuthority(){
  final PluginCall waiting;final Session own;
  synchronized(this){waiting=pendingStart;pendingStart=null;own=session;}
  if(waiting!=null)waiting.reject("Cloud streaming speech stopped","cancelled");
  if(own!=null)retire(own,"authority-changed");
 }
 protected boolean sensitiveSurfaceActive(){return false;}
 private void stopCapture(Session own){
  AudioRecord recorder=own.recorder;own.recorder=null;
  if(recorder!=null)try{recorder.stop();}catch(RuntimeException ignored){}
  Thread capture=own.capture;own.capture=null;if(capture!=null&&capture!=Thread.currentThread())try{capture.join(1500);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}
  if(own.echo!=null){own.echo.release();own.echo=null;}if(recorder!=null)recorder.release();
 }
 private void queueCleanup(Session own,Runnable done){Runnable work=()->{cleanup(own);done.run();};submit(media,work,()->{Thread thread=new Thread(work,"eliza-cloud-speech-retire");thread.setDaemon(true);thread.start();});}
 private void cleanup(Session own){
  stopCapture(own);
  Utterance u=own.spoken;if(u!=null&&u.playback!=null)try{u.playback.join(1500);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}own.spoken=null;
  final String token=own.token,origin=own.origin,id=own.serverId;own.token=null;own.wireToken=null;
  // Revoke is best effort after local microphone and speaker release; no cleanup retry can replay audio.
  if(id!=null&&origin!=null&&token!=null)try{Request request=new Request.Builder().url(origin+BASE+"session/"+id+"/revoke").header("Authorization","Bearer "+token).post(RequestBody.create("{}",JSON)).build();http.newCall(request).enqueue(new Callback(){public void onFailure(Call call,IOException failure){}public void onResponse(Call call,Response response){response.close();}});}catch(RuntimeException ignored){}
 }
 @Override protected void handleOnResume(){foreground=true;super.handleOnResume();}
 /** A pending microphone request survives its own dialog's pause; a live session tells the client why it ended. */
 @Override protected void handleOnPause(){foreground=false;Session own=session;if(own!=null)retire(own,"paused");super.handleOnPause();}
 @Override protected void handleOnDestroy(){final PluginCall pending;final Session own;synchronized(this){destroyed=true;pending=pendingStart;pendingStart=null;own=session;}if(pending!=null)pending.reject("Voice stopped");if(own!=null){detach(own);queueCleanup(own,()->{});}control.shutdown();media.shutdown();http.dispatcher().executorService().shutdown();http.connectionPool().evictAll();main.post(()->focus.close());super.handleOnDestroy();}
}
