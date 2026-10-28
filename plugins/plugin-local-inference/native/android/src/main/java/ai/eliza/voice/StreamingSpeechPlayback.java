package ai.eliza.voice;

import java.util.Arrays;
import java.util.concurrent.CancellationException;
import java.util.concurrent.TimeUnit;

/**
 * One streamed spoken utterance: synthesis chunks enter a bounded {@link SpeechPcmQueue}
 * and a writer thread plays them through an {@link Output} (an AudioTrack in MODE_STREAM on Android)
 * as they arrive, so the first sentence is audible before it is fully synthesized.
 *
 * <ul>
 * <li>Backpressure: {@link #offer} blocks the synthesis callback while the queue holds
 *     {@code capacity} samples; nothing grows without bound and no audio is written to storage.</li>
 * <li>Cancellation: {@link #stop} closes the queue (zeroing unplayed chunks), aborts the output
 *     (discarding its buffer) and makes every later {@link #offer} return false, which cancels
 *     native synthesis. Each played chunk is zeroed after it is written.</li>
 * <li>Timing: {@link Listener#firstFrame} when the first PCM reaches the output, and
 *     {@link Listener#audible} with the output's presentation time of the first sample at or above
 *     the audible level (the platform timestamp; head position only as a labelled fallback).</li>
 * </ul>
 * Exactly one terminal outcome is reported: ended, failed, or (silently) stopped by the owner.
 * Pure Java, no Android types: the host JVM fixture checks the queue, writer and cancellation.
 */
public final class StreamingSpeechPlayback {
 public interface Output {
  void play();
  /** Blocking write of mono float PCM; returns frames written or a negative platform error. */
  int write(float[] samples,int offset,int length);
  /** Frames the platform has played. */
  long playedFrames();
  /** CLOCK_MONOTONIC presentation time of {@code frame} from a rendered-output timestamp, or {@link VoiceLatencyTrials#UNSET}. */
  long presentationNs(long frame);
  void setVolume(float volume);
  /** From another thread: discard buffered audio and unblock a pending write. */
  void abort();
  void stop();
  void release();
 }
 public interface OutputFactory { Output open()throws Exception; }
 public interface Listener {
  void firstFrame(long nanos);
  void audible(long nanos,String clock);
  /** Every queued frame was played. {@code silent}: no sample reached the audible level. */
  void ended(boolean silent);
  void failed(String reason);
 }
 public interface Clock { long nanos(); }

 public static final String TIMESTAMP_CLOCK="audiotrack-timestamp",HEAD_CLOCK="audiotrack-head-position";
 public static final long POLL_MS=10;
 /** How long a full queue may block synthesis (play() not yet called, or a stalled speaker). */
 public static final long OFFER_TIMEOUT_MS=30_000;
 /** How long the writer waits for the next chunk before the synthesis counts as stalled. */
 public static final long STALL_NS=30_000_000_000L;

 private final SpeechPcmQueue queue;
 private final int sampleRate;
 private final float audibleLevel;
 private final OutputFactory outputs;
 private final Listener listener;
 private final Clock clock;
 private final Object lock=new Object();
 private Output output; // Guarded by lock.
 private float volume=1f; // Guarded by lock.
 private boolean started,terminal; // Guarded by lock.
 private volatile boolean stopped;
 private long produced; // Producer thread only.
 private volatile long audibleFrame=-1;
 private Thread writer;

 public StreamingSpeechPlayback(int capacitySamples,int sampleRate,float audibleLevel,OutputFactory outputs,Listener listener,Clock clock){
  if(sampleRate<8000||sampleRate>48000)throw new IllegalArgumentException("Unsupported sample rate");
  this.queue=new SpeechPcmQueue(capacitySamples);this.sampleRate=sampleRate;this.audibleLevel=audibleLevel;
  this.outputs=outputs;this.listener=listener;this.clock=clock;
 }

 /**
  * Synthesis callback: queues one chunk (ownership passes here) and marks completion. Blocks while
  * the queue is full. Returns false when playback was stopped or stalled: synthesis must cancel.
  */
 public boolean offer(float[] samples,boolean complete)throws InterruptedException{
  if(stopped){if(samples!=null)Arrays.fill(samples,0f);return false;}
  if(samples!=null&&samples.length>0){
   if(audibleFrame<0)for(int i=0;i<samples.length;i++)if(Math.abs(samples[i])>=audibleLevel){audibleFrame=produced+i;break;}
   produced+=samples.length;
   if(!queue.offer(samples,OFFER_TIMEOUT_MS,TimeUnit.MILLISECONDS))return false;
  }
  if(complete)queue.complete();
  return !stopped;
 }
 /** Synthesis failed after this utterance was published. Reports failed unless already terminal. */
 public void fail(String reason){
  if(!settle())return;
  stopped=true;queue.close();abortOutput();
  listener.failed(reason);
 }
 /** Starts the writer once. */
 public void start(){
  synchronized(lock){
   if(started||terminal)return;
   started=true;
   writer=new Thread(this::run,"eliza-speech-playback");writer.setDaemon(true);writer.start();
  }
 }
 /** The owner stopped this utterance (barge-in, stop, focus loss): drop unplayed audio; no callback. */
 public void stop(){
  synchronized(lock){terminal=true;}
  stopped=true;queue.close();abortOutput();
 }
 /** Audio focus: lower the volume while another sound may duck this speech, restore after. */
 public void duck(boolean ducked){
  synchronized(lock){volume=ducked?SpeechAudioFocusPolicy.DUCK_VOLUME:1f;if(output!=null)output.setVolume(volume);}
 }
 public boolean stopped(){return stopped;}
 public int queuedSamples(){return queue.queuedSamples();}
 /** Waits for the writer to exit (tests and cleanup). */
 public boolean join(long millis)throws InterruptedException{Thread active;synchronized(lock){active=writer;}if(active==null)return true;active.join(millis);return !active.isAlive();}

 private void abortOutput(){Output active;synchronized(lock){active=output;}if(active!=null)try{active.abort();}catch(RuntimeException ignored){/* The writer releases it. */}}
 private boolean settle(){synchronized(lock){if(terminal)return false;terminal=true;return true;}}

 private void run(){
  Output out;
  try{out=outputs.open();}
  catch(Exception|Error unavailable){if(settle()){stopped=true;queue.close();listener.failed("output-unavailable");}return;}
  synchronized(lock){
   if(stopped||terminal){out.release();return;}
   output=out;out.setVolume(volume);
  }
  long written=0,lastChunkAt=clock.nanos(),headNs=VoiceLatencyTrials.UNSET;
  boolean first=false,audibleReported=false;
  try{
   out.play();
   for(;;){
    float[] chunk=queue.take(POLL_MS,TimeUnit.MILLISECONDS);
    long[] audible=checkAudible(out,audibleReported,headNs);audibleReported=audible[0]==1;headNs=audible[1];
    if(chunk==null){if(clock.nanos()-lastChunkAt>STALL_NS)throw new IllegalStateException("synthesis-stalled");continue;}
    if(chunk==SpeechPcmQueue.END)break;
    try{
     int offset=0;
     while(offset<chunk.length){
      if(stopped)throw new CancellationException();
      int count=out.write(chunk,offset,chunk.length-offset);
      if(count<0)throw new IllegalStateException("output-write");
      if(count==0)Thread.sleep(POLL_MS); // A paused/aborted track accepts nothing: re-check stop.
      offset+=count;
     }
    }finally{Arrays.fill(chunk,0f);}
    lastChunkAt=clock.nanos();
    if(!first){first=true;listener.firstFrame(lastChunkAt);}
    written+=chunk.length;
    audible=checkAudible(out,audibleReported,headNs);audibleReported=audible[0]==1;headNs=audible[1];
   }
   // Every frame is queued: wait until the platform has played them, bounded by their duration.
   long played=out.playedFrames();
   long drainDeadline=clock.nanos()+Math.max(0,written-played)*1_000_000_000L/sampleRate+2_000_000_000L;
   while(!stopped&&out.playedFrames()<written&&clock.nanos()<drainDeadline){
    long[] audible=checkAudible(out,audibleReported,headNs);audibleReported=audible[0]==1;headNs=audible[1];
    Thread.sleep(POLL_MS);
   }
   if(stopped)return;
   // A track that never played every queued frame did not finish: never report it as heard.
   if(out.playedFrames()<written)throw new IllegalStateException("playback-drain-timeout");
   long[] audible=checkAudible(out,audibleReported,headNs);audibleReported=audible[0]==1;headNs=audible[1];
   if(!audibleReported&&headNs!=VoiceLatencyTrials.UNSET){audibleReported=true;listener.audible(headNs,HEAD_CLOCK);}
   out.stop();
   if(settle())listener.ended(audibleFrame<0||!first);
  }catch(CancellationException cancelled){/* Stopped by the owner or after fail(). */}
  catch(InterruptedException interrupted){Thread.currentThread().interrupt();if(settle()){stopped=true;queue.close();listener.failed("playback-interrupted");}}
  catch(Exception|Error failure){
   if(settle()){stopped=true;queue.close();String reason=failure.getMessage();listener.failed("synthesis-stalled".equals(reason)?reason:"playback-failed");}
  }finally{
   synchronized(lock){output=null;}
   try{out.release();}catch(RuntimeException ignored){/* Released. */}
  }
 }
 /** [reported?1:0, head-position fallback time]. Reports the timestamp-derived audible time once. */
 private long[] checkAudible(Output out,boolean reported,long headNs){
  long frame=audibleFrame;
  if(reported||frame<0||stopped)return new long[]{reported?1:0,headNs};
  long at=out.presentationNs(frame);
  if(at!=VoiceLatencyTrials.UNSET){listener.audible(at,TIMESTAMP_CLOCK);return new long[]{1,headNs};}
  if(headNs==VoiceLatencyTrials.UNSET&&out.playedFrames()>frame)headNs=clock.nanos();
  return new long[]{0,headNs};
 }
}
