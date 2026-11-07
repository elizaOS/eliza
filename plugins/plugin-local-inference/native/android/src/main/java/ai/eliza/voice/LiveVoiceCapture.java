package ai.eliza.voice;

import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.AudioEffect;
import android.media.audiofx.NoiseSuppressor;
import android.util.Base64;
import java.util.ArrayDeque;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Live voice capture in the app process: 16 kHz mono PCM from the microphone, Silero VAD on every
 * 32 ms window through libelizainference ({@link InferenceSession#openVad} on the process-wide
 * session), and the frames of each speech segment with its edges handed to the host's sink, which
 * forwards them to an on-device live ASR route. Audio outside a segment (beyond the short
 * pre-roll) is never forwarded, and nothing is written to storage. One capture runs at a time.
 *
 * <p>Each closed segment of a conversation pipeline also opens a latency trial
 * ({@link VoiceLatencyProbe}): the capture time of its last speech window from
 * AudioRecord.getTimestamp, and the endpoint time. Dictation opens none.
 */
public final class LiveVoiceCapture {
 public interface Sink {
  /** frames: [{pcm16 (base64 LE s16), sampleRate, channels, samples, timestamp}], vad: [{type,timestampMs}], peak in [0,1]. */
  void frames(String captureId,JSONArray frames,JSONArray vad,float peak);
  void ended(String captureId,String error);
 }
 /** One VAD detector for one capture; see {@link InferenceSession.Vad}. */
 public interface Detector {
  float[] process(float[] window);
  void reset();
  void close();
 }
 public interface DetectorFactory { Detector open()throws Exception; }
 /** Detectors from {@code inference}; it keeps them across trimMemory. */
 public static DetectorFactory detectors(InferenceSession inference){
  return ()->{
   InferenceSession.Vad vad=inference.openVad();
   return new Detector(){
    public float[] process(float[] window){return vad.process(window);}
    public void reset(){vad.reset();}
    public void close(){vad.close();}
   };
  };
 }
 public static final int SAMPLE_RATE=16000;
 /** Pipeline label of a conversation capture; its segments open latency trials. */
 public static final String CONVERSATION="live-voice",DICTATION="dictation";
 private static final int EMIT_WINDOWS=3; // about 96 ms per sink event

 /** Silero VAD is usable in this process: the bridge loads, VAD is compiled in and the bundle has its model. */
 public static boolean vadAvailable(InferenceSession inference){
  try{InferenceSession.Vad vad=inference.openVad();vad.close();return true;}catch(Exception|Error unavailable){return false;}
 }

 /**
  * Where the 16 kHz mono PCM comes from. Production uses the microphone ({@link MicrophoneSource});
  * a latency harness can substitute a paced feed when an emulator's virtual microphone delivers
  * no audio, and labels its trials with that source's clock.
  */
 public interface Source extends LiveCaptureResource.Source {
  int read(short[] buffer,int offset,int length);
  /** CLOCK_MONOTONIC capture time of the 0-based frame, or VoiceLatencyTrials.UNSET. */
  long captureTimeNs(long frame);
  /** Clock label for {@link #captureTimeNs} ("audiorecord-timestamp" for the microphone). */
  String clock();
  default boolean echoCancelled(){return false;}
  default long bufferMs(){return 0;}
  /** Unblocks read without releasing resources; close remains owned by the worker. */
  void requestStop();
  void close();
 }
 public interface SourceFactory { Source open()throws Exception; }
 /** Microphone capture with optional platform echo cancellation and native timestamps. */
 public static final class MicrophoneSource implements Source {
  private final AudioRecord recorder;
  private final android.media.AudioTimestamp stamp=new android.media.AudioTimestamp();
  private AcousticEchoCanceler echo;
  private NoiseSuppressor noise;
  private final long bufferDurationMs;
  public MicrophoneSource(Context context,boolean echoCancel)throws Exception{
   if(context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)throw new SecurityException("Microphone permission is required");
   int minimum=AudioRecord.getMinBufferSize(SAMPLE_RATE,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT);
   int bufferBytes=Math.max(minimum,LiveVadGate.WINDOW*2*16);
   bufferDurationMs=bufferBytes/2*1000L/SAMPLE_RATE;
   int source=LiveCaptureSource.select(echoCancel,AcousticEchoCanceler.isAvailable(),MediaRecorder.AudioSource.VOICE_RECOGNITION,MediaRecorder.AudioSource.VOICE_COMMUNICATION);
   recorder=new AudioRecord(source,SAMPLE_RATE,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT,bufferBytes);
   if(recorder.getState()!=AudioRecord.STATE_INITIALIZED){recorder.release();throw new IllegalStateException("Microphone unavailable");}
   if(source==MediaRecorder.AudioSource.VOICE_COMMUNICATION){
    try{echo=AcousticEchoCanceler.create(recorder.getAudioSessionId());if(echo!=null&&(echo.setEnabled(true)!=AudioEffect.SUCCESS||!echo.getEnabled())){echo.release();echo=null;}}catch(RuntimeException unavailable){release(echo,null);echo=null;}
    try{if(NoiseSuppressor.isAvailable()){noise=NoiseSuppressor.create(recorder.getAudioSessionId());if(noise!=null&&noise.setEnabled(true)!=AudioEffect.SUCCESS){noise.release();noise=null;}}}catch(RuntimeException unavailable){release(null,noise);noise=null;}
   }
   try{recorder.startRecording();}catch(RuntimeException error){release(echo,noise);recorder.release();throw error;}
  }
  public int read(short[] buffer,int offset,int length){return recorder.read(buffer,offset,length);}
  public long captureTimeNs(long frame){return VoiceLatencyProbe.captureTimeNs(recorder,stamp,frame,SAMPLE_RATE);}
  public String clock(){return "audiorecord-timestamp";}
  public boolean echoCancelled(){return echo!=null;}
  public long bufferMs(){return bufferDurationMs;}
  public void requestStop(){try{recorder.stop();}catch(RuntimeException ignored){}}
  public void close(){try{recorder.stop();}catch(RuntimeException ignored){}finally{try{recorder.release();}finally{release(echo,noise);}}}
 }

 private final String captureId;
 private final Sink sink;
 private final String pipeline;
 private final SourceFactory sources;
 private final DetectorFactory detectors;
 private volatile boolean running;
 private volatile boolean echoCancelled;
 private volatile long bufferMs;
 private Thread thread;
 private boolean startAttempted;
 private final LiveCaptureResource resource=new LiveCaptureResource();
 private volatile long startedAt;

 /** The conversation (echoCancel) or dictation microphone capture with VAD from {@code inference}. */
 public LiveVoiceCapture(Context context,InferenceSession inference,String captureId,Sink sink,boolean echoCancel){this(context,captureId,sink,echoCancel?CONVERSATION:DICTATION,()->new MicrophoneSource(context,echoCancel),detectors(inference));}
 /** {@code pipeline} labels the latency trials this capture opens ({@link #CONVERSATION} for a conversation). */
 public LiveVoiceCapture(Context context,String captureId,Sink sink,String pipeline,SourceFactory sources,DetectorFactory detectors){
  if(captureId==null||sink==null||pipeline==null||sources==null||detectors==null)throw new IllegalArgumentException("Incomplete live capture");
  this.captureId=captureId;this.sink=sink;this.pipeline=pipeline;this.sources=sources;this.detectors=detectors;
  if(context!=null)VoiceLatencyProbe.prepareIdentity(context.getApplicationContext());
 }
 public String captureId(){return captureId;}
 /** The platform echo canceller is attached and enabled on this capture (full duplex is safe). */
 public boolean echoCancelled(){return echoCancelled;}

 public void start()throws Exception{
  synchronized(this){
   if(startAttempted)throw new IllegalStateException("Live capture already started");
   startAttempted=true;running=true;
  }
  Detector vad=null;Source recorder=null;
  try{
   if(resource.stopped())throw new IllegalStateException("Live capture stopped");
   vad=detectors.open();
   if(resource.stopped())throw new IllegalStateException("Live capture stopped");
   recorder=sources.open();
   if(!resource.attach(recorder))throw new IllegalStateException("Live capture stopped");
   synchronized(this){
    if(!running)throw new IllegalStateException("Live capture stopped");
    startedAt=System.currentTimeMillis();echoCancelled=recorder.echoCancelled();bufferMs=recorder.bufferMs();
    final Source opened=recorder;final Detector openedVad=vad;
    thread=new Thread(()->loop(opened,openedVad),"eliza-live-voice");
    thread.start();
   }
  }catch(Exception|Error error){
   running=false;
   try{if(recorder!=null)resource.release(recorder);}finally{if(vad!=null)vad.close();}
   throw error;
  }
 }

 private static void release(AcousticEchoCanceler echo,NoiseSuppressor noise){
  if(echo!=null)try{echo.release();}catch(RuntimeException ignored){}
  if(noise!=null)try{noise.release();}catch(RuntimeException ignored){}
 }

 /** Marks cancellation without waiting for native startup, read, stop or release. */
 public void cancelPending(){running=false;resource.cancel();}
 /** Unblocks an already-open source; call off the UI thread. */
 public void requestStop(){cancelPending();resource.requestStop();}
 private volatile String interruption;
 /** Stops capture because the platform took the microphone path (a phone call); the end event reports {@code reason}. Off the UI thread. */
 public void interrupt(String reason){interruption=reason;requestStop();}

 /** Stops capture; returns the capture duration. The host closes an open segment itself. */
 public long stop(){
  Thread active;synchronized(this){running=false;active=thread;}
  resource.requestStop(); // AudioRecord.stop unblocks a read before waiting for its worker.
  if(active!=null&&active!=Thread.currentThread()){try{active.join(1500);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}}
  long began=startedAt;return began==0?0:Math.max(0,System.currentTimeMillis()-began);
 }

 private void loop(Source recorder,Detector vad){
  String error=null;
  LiveVadGate gate=new LiveVadGate();
  ArrayDeque<JSONObject> preroll=new ArrayDeque<>();
  JSONArray frames=new JSONArray(),edges=new JSONArray();
  short[] window=new short[LiveVadGate.WINDOW];
  float[] pcm=new float[LiveVadGate.WINDOW];
  byte[] bytes=new byte[LiveVadGate.WINDOW*2];
  int windows=0;float peak=0f;
  // Latency collector: capture time of the last sample of the last window the gate still counts as
  // speech. Speech can end anywhere inside that 32 ms window, so the latency is understated by at
  // most one window; frames the platform drops would overstate it instead.
  long framesRead=0,lastSpeechNs=VoiceLatencyTrials.UNSET;String lastSpeechClock=recorder.clock();
  try{
   vad.reset();
   while(running){
    int filled=0;
    while(filled<window.length&&running){int read=recorder.read(window,filled,window.length-filled);if(read<0)throw new IllegalStateException("Microphone read failed");filled+=read;}
    if(!running)break;
    framesRead+=window.length;
    long at=Math.max(startedAt+framesRead*1000/SAMPLE_RATE,System.currentTimeMillis()-bufferMs);
    long windowEndNs=recorder.captureTimeNs(framesRead-1);
    String windowClock=recorder.clock();
    if(windowEndNs==VoiceLatencyTrials.UNSET){windowEndNs=System.nanoTime();windowClock="read-return";}
    for(int i=0;i<window.length;i++){short sample=window[i];pcm[i]=sample/32768f;bytes[i*2]=(byte)(sample&0xff);bytes[i*2+1]=(byte)((sample>>8)&0xff);peak=Math.max(peak,Math.abs(pcm[i]));}
    float[] probability=vad.process(pcm);
    JSONObject frame=new JSONObject();
    frame.put("pcm16",Base64.encodeToString(bytes,Base64.NO_WRAP));frame.put("sampleRate",SAMPLE_RATE);frame.put("channels",1);frame.put("samples",window.length);frame.put("timestamp",at);
    float speech=probability!=null&&probability.length>0?probability[0]:0f;
    LiveVadGate.Edge edge=gate.accept(speech);
    if((gate.speaking()||edge==LiveVadGate.Edge.SPEECH_START)&&speech>=LiveVadGate.END){lastSpeechNs=windowEndNs;lastSpeechClock=windowClock;}
    if(edge==LiveVadGate.Edge.SPEECH_END&&!DICTATION.equals(pipeline)){VoiceLatencyProbe.TRIALS.speechEnded(lastSpeechNs,System.nanoTime(),lastSpeechClock,pipeline);lastSpeechNs=VoiceLatencyTrials.UNSET;}
    if(edge==LiveVadGate.Edge.SPEECH_START){
     edges.put(new JSONObject().put("type","speech-start").put("timestampMs",at-(long)(LiveVadGate.START_WINDOWS-1)*32));
     while(!preroll.isEmpty())frames.put(preroll.removeFirst());
     frames.put(frame);
    }else if(gate.speaking()){frames.put(frame);}
    else if(edge==LiveVadGate.Edge.SPEECH_END){frames.put(frame);edges.put(new JSONObject().put("type","speech-end").put("timestampMs",at));}
    else{preroll.addLast(frame);while(preroll.size()>LiveVadGate.PREROLL_WINDOWS)preroll.removeFirst();}
    if(++windows>=EMIT_WINDOWS||edges.length()>0){
     sink.frames(captureId,frames,edges,Math.min(1f,peak));
     frames=new JSONArray();edges=new JSONArray();windows=0;peak=0f;
    }
   }
   // Frames of an open segment read before the stop still belong to the utterance.
   if(frames.length()>0||edges.length()>0)sink.frames(captureId,frames,edges,Math.min(1f,peak));
  }catch(Exception|Error failure){if(running)error="capture";}
  finally{
   try{resource.release(recorder);}finally{vad.close();}
   java.util.Arrays.fill(bytes,(byte)0);java.util.Arrays.fill(window,(short)0);java.util.Arrays.fill(pcm,0f);
   preroll.clear();
   sink.ended(captureId,error!=null?error:interruption);
  }
 }
}
