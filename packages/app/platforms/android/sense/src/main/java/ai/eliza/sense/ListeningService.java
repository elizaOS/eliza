package ai.eliza.sense;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.KeyguardManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.ContentObserver;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioPlaybackConfiguration;
import android.media.AudioRecord;
import android.media.AudioRecordingConfiguration;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The always-on microphone foreground service (type microphone). It runs only while
 * {@link ListenerPolicy#foreground} allows and opens the microphone only while
 * {@link ListenerPolicy#holdsMicrophone} allows. Audio is analysed in RAM: voice activity and turn
 * segmentation ({@link SpeechGate}), then on-device recognition with the fused libelizainference
 * engine ({@link ai.eliza.voice.NativeAsr} on the voice bundle's ASR slot), then {@link WakePhrase}. Every
 * audio buffer is zeroed after use and transcripts are dropped after classification. Nothing is
 * written to storage and this package has no network permission.
 *
 * Ringing and calls (audio mode), another app taking the microphone and the microphone privacy
 * toggle (both reported as a silenced recording) pause analysis. Speech-capable playback
 * suppresses wake detection so the assistant's own speech or media does not invoke it, and the
 * wake phrase never opens the host while the phone is locked.
 */
public class ListeningService extends Service {
 private static final String TAG="SenseListener";
 /** android.media.MediaRecorder.AudioSource.HOTWORD (system API): a capture that yields to every other client. */
 static final int AUDIO_SOURCE_HOTWORD=1999;
 private static final long ECHO_GUARD_MS=1500;

 private final Handler main=new Handler(Looper.getMainLooper());
 private final ExecutorService recognizer=Executors.newSingleThreadExecutor(runnable->new Thread(runnable,"listener-asr"));
 private final AtomicBoolean recognizing=new AtomicBoolean();
 private volatile boolean analyse;
 private volatile boolean destroyed;
 private volatile long playbackQuietSince=0;
 private volatile Thread capture;
 private volatile AudioRecord record;
 private final Object engineLock=new Object();
 private volatile ai.eliza.voice.NativeAsr engine;
 private AudioManager audio;
 private final Runnable reapply=this::apply;
 /**
  * Android reports neither a channel lowered to silent/hidden nor the lock-screen notification
  * setting changing, so while the microphone is held the indicator is re-checked on a short timer;
  * losing it converges the service (and closes the microphone) through {@link #apply}.
  */
 private final Runnable indicatorCheck=new Runnable(){
  @Override public void run(){
   if(destroyed)return;
   if(!ListenerNotifications.indicatorVisible(ListeningService.this))apply();
   else main.postDelayed(this,ListenerPolicy.INDICATOR_RECHECK_MS);
  }
 };
 /**
  * SystemUI's indicator health lease (docs/aosp-listening-chip.md): while the microphone is held it
  * is re-checked at least every {@link IndicatorLease#RENEW_MS} and no later than its expiry. A
  * lease that is expired, revoked, hidden, unattributed or whose SystemUI binder died latches
  * {@link ListenerPolicy.State#STOPPED_INDICATOR_LOST} through {@link #apply}, which closes the microphone.
  */
 private final Runnable leaseCheck=new Runnable(){
  @Override public void run(){
   if(destroyed)return;
   long now=SystemClock.elapsedRealtime();
   if(!Listener.observeIndicatorLease(ListeningService.this,now))apply();
   else main.postDelayed(this,Listener.lease.nextCheckDelay(now));
  }
 };
 private final AtomicBoolean leaseStopPosted=new AtomicBoolean();
 private final ContentObserver lockScreenSetting=new ContentObserver(main){
  @Override public void onChange(boolean selfChange){main.post(reapply);}
 };

 private final AudioManager.OnModeChangedListener modes=mode->{
  // Ringing counts: the listener stops transcribing as soon as the phone rings (see ListenerPolicy.callMode).
  Listener.inCall=ListenerPolicy.callMode(mode);
  main.post(reapply);
 };

 private final AudioManager.AudioRecordingCallback recordings=new AudioManager.AudioRecordingCallback(){
  @Override public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs){updateRecordings(configs);}
 };

 /**
  * Any other active recording pauses the listener and releases the microphone, so it never competes
  * with the app the user is using (including the host's own voice turn). Our own recording being
  * silenced without another visible client is the microphone privacy toggle or audio policy.
  */
 private void updateRecordings(List<AudioRecordingConfiguration> configs){
  AudioRecord current=record;
  int session=current==null?AudioManager.ERROR:current.getAudioSessionId();
  boolean other=false,silenced=false;
  for(AudioRecordingConfiguration config:configs){
   if(config.getClientAudioSessionId()==session)silenced=config.isClientSilenced();
   else other=true;
  }
  if(other!=Listener.otherAppRecording||silenced!=Listener.micSilenced){
   Listener.otherAppRecording=other;
   if(silenced!=Listener.micSilenced)Listener.unsilencedSince=silenced||current==null?-1:SystemClock.elapsedRealtime();
   Listener.micSilenced=silenced;
   main.post(reapply);
  }
 }

 private final AudioManager.AudioPlaybackCallback playback=new AudioManager.AudioPlaybackCallback(){
  @Override public void onPlaybackConfigChanged(List<AudioPlaybackConfiguration> configs){updatePlayback(configs);}
 };

 @Override public void onCreate(){
  super.onCreate();
  audio=getSystemService(AudioManager.class);
  ListenerNotifications.channels(this);
  audio.addOnModeChangedListener(getMainExecutor(),modes);
  modes.onModeChanged(audio.getMode());
  audio.registerAudioRecordingCallback(recordings,main);
  updateRecordings(audio.getActiveRecordingConfigurations());
  audio.registerAudioPlaybackCallback(playback,main);
  updatePlayback(audio.getActivePlaybackConfigurations());
  try{getContentResolver().registerContentObserver(Settings.Secure.getUriFor(ListenerNotifications.LOCK_SCREEN_SHOW_NOTIFICATIONS),false,lockScreenSetting);}
  catch(RuntimeException unavailable){/* the periodic indicator check still applies */}
 }

 @Override public int onStartCommand(Intent intent,int flags,int startId){apply();return START_STICKY;}

 @Override public IBinder onBind(Intent intent){return null;}

 @Override public void onDestroy(){
  destroyed=true;
  main.removeCallbacks(reapply);
  main.removeCallbacks(indicatorCheck);
  main.removeCallbacks(leaseCheck);
  try{getContentResolver().unregisterContentObserver(lockScreenSetting);}catch(RuntimeException ignored){}
  stopCapture();
  audio.removeOnModeChangedListener(modes);
  audio.unregisterAudioRecordingCallback(recordings);
  audio.unregisterAudioPlaybackCallback(playback);
  // The model is released on the recognition thread after any in-flight utterance, then the thread ends.
  recognizer.execute(()->{synchronized(engineLock){if(engine!=null){engine.close();engine=null;}}});
  recognizer.shutdown();
  super.onDestroy();
 }

 /** Re-evaluates policy and converges the service, notification and microphone on it. */
 private void apply(){ListenerStore.serializeConsent(this::applyUnderConsentLock);}

 /** A reset cannot interleave a LISTENING snapshot with capture/epoch renewal. */
 private void applyUnderConsentLock(){
  if(destroyed)return;
  Listener.epoch.invalidate();
  main.removeCallbacks(reapply);
  main.removeCallbacks(indicatorCheck);
  main.removeCallbacks(leaseCheck);
  leaseStopPosted.set(false);
  // Evaluated while any open AudioRecord is still marked held, so a lost lease latches before capture stops.
  ListenerPolicy.State state=Listener.state(this);
  if(!ListenerPolicy.foreground(state)){
   stopCapture();
   stopForeground(STOP_FOREGROUND_REMOVE);
   stopSelf();
   ListenerNotifications.showStatus(this,state);
   return;
  }
  try{
   startForeground(ListenerNotifications.ACTIVE_ID,ListenerNotifications.active(this,state),ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
  }catch(RuntimeException refused){
   // Android refused the microphone service (no while-in-use exemption or permission). Never capture without it.
   Log.w(TAG,"Foreground microphone service refused: "+refused.getClass().getSimpleName());
   stopCapture();stopSelf();return;
  }
  ListenerNotifications.showStatus(this,state);
  analyse=ListenerPolicy.processesAudio(state);
  if(ListenerPolicy.holdsMicrophone(state)){startCapture();main.postDelayed(indicatorCheck,ListenerPolicy.INDICATOR_RECHECK_MS);main.postDelayed(leaseCheck,Listener.lease.nextCheckDelay(SystemClock.elapsedRealtime()));}
  else stopCapture();
  long until=new ListenerStore(this).pausedUntil(),now=SystemClock.elapsedRealtime();
  if(state==ListenerPolicy.State.PAUSED_USER&&until!=ListenerPolicy.PAUSE_UNTIL_RESUMED)main.postDelayed(reapply,Math.max(1000,until-now));
  Listener.epoch.renew(analyse);
  if(analyse)recognizer.execute(this::loadEngine);
 }

 private void loadEngine(){
  synchronized(engineLock){
   if(destroyed||engine!=null)return;
   try{engine=ai.eliza.voice.VoiceAssets.install(this).openAsr();if(!destroyed)Listener.speechUnavailable=false;}
   catch(Throwable failed){Log.w(TAG,"Local speech model unavailable: "+failed.getClass().getSimpleName());if(!destroyed){Listener.speechUnavailable=true;main.post(reapply);}}
  }
 }

 private synchronized void startCapture(){
  if(capture!=null)return;
  if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)return;
  boolean hotword=checkSelfPermission("android.permission.CAPTURE_AUDIO_HOTWORD")==PackageManager.PERMISSION_GRANTED;
  int bytes=Math.max(AudioRecord.getMinBufferSize(SpeechGate.SAMPLE_RATE,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT),SpeechGate.FRAME_SAMPLES*2*10);
  AudioRecord opened;
  try{opened=open(hotword,bytes);}
  catch(RuntimeException unavailable){Log.w(TAG,"Microphone unavailable");Listener.micSilenced=true;main.postDelayed(reapply,30_000);return;}
  if(opened.getState()!=AudioRecord.STATE_INITIALIZED){opened.release();Listener.micSilenced=true;main.postDelayed(reapply,30_000);return;}
  if (!new ListenerStore(this).setSessionOpen(true)) { opened.release(); main.post(reapply); return; }
  record=opened;
  Listener.unsilencedSince=Listener.micSilenced?-1:SystemClock.elapsedRealtime();
  Listener.microphoneHeld=true;
  Thread thread=new Thread(()->captureLoop(opened),"listener-capture");
  capture=thread;
  thread.start();
 }

 /**
  * HOTWORD is accepted only by the legacy constructor (AudioRecord.Builder limits sources to the
  * public set). Without CAPTURE_AUDIO_HOTWORD (a developer install outside the image) the listener
  * uses VOICE_RECOGNITION and relies on {@link #updateRecordings} to release the microphone
  * whenever another app records.
  */
 @SuppressLint("WrongConstant")
 private AudioRecord open(boolean hotword,int bytes){
  if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)throw new SecurityException("RECORD_AUDIO");
  return new AudioRecord(hotword?AUDIO_SOURCE_HOTWORD:MediaRecorder.AudioSource.VOICE_RECOGNITION,SpeechGate.SAMPLE_RATE,
   AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT,bytes);
 }

 private synchronized void stopCapture(){
  Listener.epoch.invalidate();
  ai.eliza.voice.NativeAsr active=engine;if(active!=null)try{active.cancel();}catch(RuntimeException unavailable){/* Epoch fencing still drops late recognition. */}
  Thread thread=capture;
  capture=null;analyse=false;
  AudioRecord current=record;record=null;
  // stop() unblocks a pending read; the capture thread then sees it is no longer current and exits.
  if(current!=null)try{current.stop();}catch(RuntimeException ignored){}
  if(thread!=null){try{thread.join(1000);}catch(InterruptedException ignored){Thread.currentThread().interrupt();}}
  if(current!=null)current.release();
  if(thread!=null)new ListenerStore(this).setSessionOpen(false);
  Listener.microphoneHeld=false;
  Listener.unsilencedSince=-1;
  Listener.micSilenced=false;
 }

 private void captureLoop(AudioRecord source){
  short[] frame=new short[SpeechGate.FRAME_SAMPLES];
  long[] frameTicket={-1};
  SpeechGate gate=new SpeechGate(samples->onUtterance(samples,frameTicket[0]));
  try{
   source.startRecording();
   while(capture==Thread.currentThread()&&!Thread.currentThread().isInterrupted()){
    long ticket=Listener.epoch.ticket();
    int filled=0;
    while(filled<frame.length){
     int read=source.read(frame,filled,frame.length-filled,AudioRecord.READ_BLOCKING);
     if(read<0)throw new IllegalStateException("read "+read);
     filled+=read;
     if(capture!=Thread.currentThread())break;
    }
    if(ticket!=frameTicket[0]){gate.reset();frameTicket[0]=ticket;}
    // No frame is analysed without a fresh SystemUI lease; a loss is converged (and latched) on the main thread.
    boolean leased=Listener.observeIndicatorLease(this,SystemClock.elapsedRealtime());
    if(!leased&&leaseStopPosted.compareAndSet(false,true))main.post(reapply);
    if(filled==frame.length&&leased&&analyse&&Listener.epoch.current(ticket)&&SystemClock.elapsedRealtime()>=playbackQuietSince+ECHO_GUARD_MS)gate.accept(frame);else gate.reset();
    Arrays.fill(frame,(short)0);
   }
  }catch(RuntimeException failed){
   Log.w(TAG,"Capture stopped: "+failed.getClass().getSimpleName());
   Thread failedThread=Thread.currentThread();
   main.post(()->{if(capture!=failedThread||record!=source)return;stopCapture();main.postDelayed(reapply,5000);});
  }finally{
   gate.reset();
   Arrays.fill(frame,(short)0);
   try{source.stop();}catch(RuntimeException ignored){}
  }
 }

 /** Called on the capture thread with a fresh array this method now owns. */
 private void onUtterance(float[] samples,long ticket){
  if(!Listener.epoch.current(ticket)||!analyse||SystemClock.elapsedRealtime()<playbackQuietSince+ECHO_GUARD_MS||!recognizing.compareAndSet(false,true)){Arrays.fill(samples,0f);return;}
  try{
   recognizer.execute(()->{
    String text=null;
    try{
     ai.eliza.voice.NativeAsr local;
     synchronized(engineLock){local=engine;}
     if(local==null||!analyse||!Listener.epoch.current(ticket))return;
     // Never recognise speech while the listener's own indicator is hidden; converge on the main thread.
     if(!ListenerNotifications.indicatorVisible(this)){main.post(reapply);return;}
     if(!Listener.observeIndicatorLease(this,SystemClock.elapsedRealtime())){main.post(reapply);return;}
     text=local.transcribe(samples);
     WakePhrase.Action action=WakePhrase.classify(text,BuildConfig.SENSE_WAKE_NAMES.split(","));
     text=null;
     if(action==WakePhrase.Action.IGNORE||!analyse||!Listener.epoch.current(ticket))return;
     main.post(()->act(action,ticket));
    }catch(RuntimeException failed){Log.w(TAG,"Recognition failed: "+failed.getClass().getSimpleName());}
    finally{Arrays.fill(samples,0f);recognizing.set(false);}
   });
  }catch(RuntimeException rejected){Arrays.fill(samples,0f);recognizing.set(false);}
 }

 private void act(WakePhrase.Action action,long ticket){
  if(!Listener.epoch.current(ticket))return;
  if(Listener.state(this)!=ListenerPolicy.State.LISTENING)return;
  if(action==WakePhrase.Action.PAUSE_LISTENING){
   new ListenerStore(this).pause(ListenerPolicy.PAUSE_UNTIL_RESUMED);
   Listener.refresh(this);
  }else if(action==WakePhrase.Action.INVOKE){
   KeyguardManager keyguard=getSystemService(KeyguardManager.class);
   // Never open the host behind the keyguard; unknown keyguard state counts as locked.
   if(!ListenerPolicy.mayInvokeAssistant(keyguard==null||keyguard.isKeyguardLocked()))Log.i(TAG,"Wake phrase ignored while locked");
   else if(!AssistantInvocation.start(this))Log.w(TAG,"Assistant invocation refused");
  }
 }

 /**
  * Any playback that can carry speech (media, which includes the host's own WebView voice, assistant,
  * accessibility, navigation, games, calls or an unknown usage) suppresses wake detection while it
  * plays and briefly afterwards, so a speaker saying the wake name cannot invoke the assistant. Only
  * short non-speech system sounds do not (see {@link ListenerPolicy#playbackSuppressesWake}).
  */
 private void updatePlayback(List<AudioPlaybackConfiguration> configs){
  boolean speaking=false;
  for(AudioPlaybackConfiguration config:configs){
   AudioAttributes attributes=config.getAudioAttributes();
   if(attributes==null||ListenerPolicy.playbackSuppressesWake(attributes.getUsage()))speaking=true;
  }
  if(speaking){Listener.epoch.invalidate();playbackQuietSince=Long.MAX_VALUE-ECHO_GUARD_MS;}
  else if(playbackQuietSince==Long.MAX_VALUE-ECHO_GUARD_MS){playbackQuietSince=SystemClock.elapsedRealtime();main.post(reapply);}
 }
}
