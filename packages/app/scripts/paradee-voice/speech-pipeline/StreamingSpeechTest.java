package ai.eliza.voice;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Host-JVM check of streamed speech logic: the bounded PCM queue, the playback writer
 * (with a fake output instead of AudioTrack), cancellation, the audio-focus policy and per-chunk
 * validation. Not Android, AudioTrack, device audio or latency evidence.
 */
public final class StreamingSpeechTest {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 private static float[] tone(int length,float level){float[] out=new float[length];java.util.Arrays.fill(out,level);return out;}
 private static boolean zero(float[] samples){for(float sample:samples)if(sample!=0f)return false;return true;}

 /** Plays instantly; timestamps place frame f at base + f/rate once anything was written. */
 static class FakeOutput implements StreamingSpeechPlayback.Output {
  final List<float[]> written=new ArrayList<>();final List<float[]> originals=new ArrayList<>();
  long frames;float volume=-1;boolean played,stopped,released,aborted,timestamps=true;
  CountDownLatch blockWrites;final CountDownLatch writing=new CountDownLatch(1);
  static final long BASE=1_000_000_000L;
  public synchronized void play(){played=true;}
  public int write(float[] samples,int offset,int length){
   writing.countDown();
   CountDownLatch gate;synchronized(this){gate=blockWrites;}
   if(gate!=null)try{gate.await(5,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}
   synchronized(this){if(aborted)return 0;written.add(java.util.Arrays.copyOfRange(samples,offset,offset+length));originals.add(samples);frames+=length;return length;}
  }
  public synchronized long playedFrames(){return frames;}
  public synchronized long presentationNs(long frame){return timestamps&&frames>0?BASE+frame*1_000_000_000L/24000:VoiceLatencyTrials.UNSET;}
  public synchronized void setVolume(float value){volume=value;}
  public void abort(){CountDownLatch gate;synchronized(this){aborted=true;gate=blockWrites;}if(gate!=null)gate.countDown();}
  public synchronized void stop(){stopped=true;}
  public synchronized void release(){released=true;}
 }
 static final class Events implements StreamingSpeechPlayback.Listener {
  final AtomicInteger first=new AtomicInteger(),ended=new AtomicInteger(),failed=new AtomicInteger();
  volatile long audibleAt=VoiceLatencyTrials.UNSET;volatile String audibleClock,failure;volatile boolean silent;
  final CountDownLatch done=new CountDownLatch(1);
  public void firstFrame(long nanos){first.incrementAndGet();}
  public void audible(long nanos,String clock){audibleAt=nanos;audibleClock=clock;}
  public void ended(boolean value){silent=value;ended.incrementAndGet();done.countDown();}
  public void failed(String reason){failure=reason;failed.incrementAndGet();done.countDown();}
 }

 public static void main(String[] args)throws Exception{
  // Queue: capacity in samples, ownership, completion and cancellation.
  SpeechPcmQueue queue=new SpeechPcmQueue(48_000);
  float[] a=tone(24_000,.5f),b=tone(24_000,.5f),c=tone(24_000,.5f);
  check(queue.offer(a,10,TimeUnit.MILLISECONDS)&&queue.offer(b,10,TimeUnit.MILLISECONDS),"two chunks fit");
  check(!queue.offer(c,30,TimeUnit.MILLISECONDS)&&zero(c),"a full queue times out and zeroes the refused chunk");
  check(queue.queuedSamples()==48_000,"queued samples never exceed the capacity");
  check(queue.take(10,TimeUnit.MILLISECONDS)==a,"first in, first out");
  check(queue.take(10,TimeUnit.MILLISECONDS)==b&&queue.take(10,TimeUnit.MILLISECONDS)==null,"an empty open queue is an underrun");
  queue.complete();check(queue.take(10,TimeUnit.MILLISECONDS)==SpeechPcmQueue.END,"END after completion");
  SpeechPcmQueue closing=new SpeechPcmQueue(24_000);float[] held=tone(24_000,.3f);closing.offer(held,10,TimeUnit.MILLISECONDS);closing.close();
  check(zero(held)&&closing.queuedSamples()==0,"close zeroes and drops unplayed audio");
  try{closing.take(10,TimeUnit.MILLISECONDS);throw new AssertionError("closed take");}catch(CancellationException expected){/* closed */}
  float[] late=tone(100,.3f);check(!closing.offer(late,10,TimeUnit.MILLISECONDS)&&zero(late),"a closed queue refuses chunks");
  try{new SpeechPcmQueue(1000);throw new AssertionError("capacity below a chunk");}catch(IllegalArgumentException expected){/* bounded */}
  try{queue.offer(new float[24_001],1,TimeUnit.MILLISECONDS);throw new AssertionError("oversized chunk");}catch(IllegalArgumentException expected){/* bounded */}

  // Backpressure: a fast producer blocks on a slow consumer; the queue stays bounded.
  SpeechPcmQueue paced=new SpeechPcmQueue(48_000);int[] peak={0};
  Thread producer=new Thread(()->{try{for(int i=0;i<12;i++)if(!paced.offer(tone(12_000,.2f),5,TimeUnit.SECONDS))throw new AssertionError("blocked producer gave up");paced.complete();}catch(InterruptedException e){throw new AssertionError(e);}});
  producer.start();int taken=0;
  for(;;){Thread.sleep(2);peak[0]=Math.max(peak[0],paced.queuedSamples());float[] next=paced.take(1,TimeUnit.SECONDS);if(next==SpeechPcmQueue.END)break;if(next!=null)taken++;}
  producer.join(5000);
  check(taken==12&&peak[0]<=48_000,"backpressure delivers every chunk without exceeding the bound");

  // Streamed playback: chunks play as they arrive; first frame, audible time, end; buffers zeroed.
  FakeOutput output=new FakeOutput();Events events=new Events();
  StreamingSpeechPlayback playback=new StreamingSpeechPlayback(48_000,24_000,.01f,()->output,events,System::nanoTime);
  float[] lead=tone(1_000,0f),speech=tone(24_000,.4f),tail=tone(4_000,.2f);
  check(playback.offer(lead,false)&&playback.offer(speech,false),"chunks before play() are buffered");
  playback.start();
  check(playback.offer(tail,false)&&playback.offer(new float[0],true),"completion arrives as an empty final chunk");
  check(events.done.await(5,TimeUnit.SECONDS)&&events.ended.get()==1&&events.failed.get()==0,"the utterance ends once");
  check(playback.join(2000),"the writer exits");
  check(events.first.get()==1&&!events.silent,"first frame reported once; not silent");
  check(events.audibleAt==FakeOutput.BASE+1_000L*1_000_000_000L/24_000&&StreamingSpeechPlayback.TIMESTAMP_CLOCK.equals(events.audibleClock),"audible time is the output timestamp of the first non-silent sample");
  check(output.written.size()==3&&output.written.get(1)[0]==.4f,"every chunk reached the output in order");
  check(zero(lead)&&zero(speech)&&zero(tail),"played chunks are zeroed after the write");
  check(output.played&&output.stopped&&output.released,"track played, stopped and released");

  // A track that stalls before playing every queued frame failed: the sentence is never reported as heard.
  FakeOutput stalled=new FakeOutput(){@Override public synchronized long playedFrames(){return Math.min(frames,1_000);}};Events stall=new Events();
  StreamingSpeechPlayback stalling=new StreamingSpeechPlayback(48_000,24_000,.01f,()->stalled,stall,System::nanoTime);
  stalling.start();check(stalling.offer(tone(2_400,.4f),false)&&stalling.offer(new float[0],true),"stalled utterance accepted");
  check(stall.done.await(10,TimeUnit.SECONDS)&&stall.ended.get()==0&&stall.failed.get()==1&&"playback-failed".equals(stall.failure),"a drain timeout fails instead of ending");
  check(stalling.join(2000),"the stalled writer exits");

  // Head-position fallback when the platform never gives a timestamp.
  FakeOutput untimed=new FakeOutput();untimed.timestamps=false;Events fallback=new Events();
  StreamingSpeechPlayback headOnly=new StreamingSpeechPlayback(48_000,24_000,.01f,()->untimed,fallback,System::nanoTime);
  headOnly.start();headOnly.offer(tone(2_400,.3f),true);
  check(fallback.done.await(5,TimeUnit.SECONDS)&&StreamingSpeechPlayback.HEAD_CLOCK.equals(fallback.audibleClock),"head position is a labelled fallback");

  // Silent output ends as silent (no audible time).
  Events quiet=new Events();FakeOutput silentOut=new FakeOutput();
  StreamingSpeechPlayback silent=new StreamingSpeechPlayback(48_000,24_000,.01f,()->silentOut,quiet,System::nanoTime);
  silent.start();silent.offer(tone(2_400,0f),true);
  check(quiet.done.await(5,TimeUnit.SECONDS)&&quiet.silent&&quiet.audibleAt==VoiceLatencyTrials.UNSET,"a silent stream is reported silent");

  // Barge-in/stop mid-write: the write unblocks, queued audio is zeroed, synthesis is cancelled,
  // and the owner gets no terminal callback (it reports the stop itself).
  FakeOutput blocked=new FakeOutput();blocked.blockWrites=new CountDownLatch(1);Events stoppedEvents=new Events();
  StreamingSpeechPlayback barge=new StreamingSpeechPlayback(48_000,24_000,.01f,()->blocked,stoppedEvents,System::nanoTime);
  float[] playing=tone(24_000,.5f),queued=tone(24_000,.5f);
  barge.offer(playing,false);barge.start();check(blocked.writing.await(5,TimeUnit.SECONDS),"writer is writing");
  barge.offer(queued,false);
  barge.stop();
  check(barge.join(5000),"stop unblocks and ends the writer");
  check(zero(queued)&&zero(playing),"unplayed and in-flight audio is zeroed");
  float[] after=tone(100,.5f);check(!barge.offer(after,false)&&zero(after),"synthesis is told to cancel after stop");
  check(stoppedEvents.ended.get()==0&&stoppedEvents.failed.get()==0&&blocked.aborted&&blocked.released,"stop is silent toward the owner; track aborted and released");

  // A synthesis failure after publication fails the utterance exactly once.
  Events failing=new Events();FakeOutput failOut=new FakeOutput();
  StreamingSpeechPlayback broken=new StreamingSpeechPlayback(48_000,24_000,.01f,()->failOut,failing,System::nanoTime);
  broken.start();broken.offer(tone(2_400,.3f),false);broken.fail("synthesis-failed");broken.fail("again");broken.stop();
  check(broken.join(5000)&&failing.failed.get()==1&&"synthesis-failed".equals(failing.failure)&&failing.ended.get()==0,"one failure outcome");

  // An output that cannot open fails the utterance.
  Events noOutput=new Events();
  StreamingSpeechPlayback missing=new StreamingSpeechPlayback(48_000,24_000,.01f,()->{throw new IllegalStateException("no track");},noOutput,System::nanoTime);
  missing.start();check(noOutput.done.await(5,TimeUnit.SECONDS)&&"output-unavailable".equals(noOutput.failure),"output failure is reported");
  float[] refused=tone(100,.3f);check(!missing.offer(refused,false)&&zero(refused),"and synthesis is cancelled");

  // Ducking follows focus.
  FakeOutput ducked=new FakeOutput();ducked.blockWrites=new CountDownLatch(1);Events duckEvents=new Events();
  StreamingSpeechPlayback duck=new StreamingSpeechPlayback(48_000,24_000,.01f,()->ducked,duckEvents,System::nanoTime);
  duck.offer(tone(2_400,.3f),false);duck.start();ducked.writing.await(5,TimeUnit.SECONDS);
  duck.duck(true);check(ducked.volume==SpeechAudioFocusPolicy.DUCK_VOLUME,"ducked volume");
  duck.duck(false);check(ducked.volume==1f,"restored volume");
  duck.stop();duck.join(5000);

  // Audio focus and call policy.
  SpeechAudioFocusPolicy focus=new SpeechAudioFocusPolicy();
  check(focus.changed(SpeechAudioFocusPolicy.Event.LOSS)==SpeechAudioFocusPolicy.Action.NONE,"no focus held, nothing to do");
  check(!focus.granted(false)&&!focus.held(),"a denied request holds nothing");
  check(focus.granted(true)&&focus.held(),"granted");
  check(focus.changed(SpeechAudioFocusPolicy.Event.LOSS_TRANSIENT_CAN_DUCK)==SpeechAudioFocusPolicy.Action.DUCK,"can-duck ducks");
  check(focus.changed(SpeechAudioFocusPolicy.Event.LOSS_TRANSIENT_CAN_DUCK)==SpeechAudioFocusPolicy.Action.NONE,"duck once");
  check(focus.changed(SpeechAudioFocusPolicy.Event.GAIN)==SpeechAudioFocusPolicy.Action.RESTORE,"regain restores");
  check(focus.changed(SpeechAudioFocusPolicy.Event.GAIN)==SpeechAudioFocusPolicy.Action.NONE,"regain while unducked does nothing");
  check(focus.changed(SpeechAudioFocusPolicy.Event.LOSS_TRANSIENT)==SpeechAudioFocusPolicy.Action.STOP&&!focus.held(),"transient loss stops and clears");
  check(focus.changed(SpeechAudioFocusPolicy.Event.GAIN)==SpeechAudioFocusPolicy.Action.NONE,"a stopped utterance never resumes on regain");
  focus.granted(true);
  check(focus.changed(SpeechAudioFocusPolicy.Event.LOSS)==SpeechAudioFocusPolicy.Action.STOP,"permanent loss stops");
  focus.granted(true);focus.released();check(!focus.held(),"released after speech");
  for(SpeechAudioFocusPolicy.Mode mode:SpeechAudioFocusPolicy.Mode.values()){
   boolean call=mode!=SpeechAudioFocusPolicy.Mode.NORMAL&&mode!=SpeechAudioFocusPolicy.Mode.OTHER;
   check(SpeechAudioFocusPolicy.callActive(mode)==call,"call mode "+mode);
   check(call==SpeechAudioFocusPolicy.CALL_ACTIVE.equals(SpeechAudioFocusPolicy.admission(mode)),"speech refused during "+mode);
   check(SpeechAudioFocusPolicy.stopsCapture(SpeechAudioFocusPolicy.Action.STOP,mode)==call,"capture stops for a call "+mode);
  }
  check(!SpeechAudioFocusPolicy.stopsCapture(SpeechAudioFocusPolicy.Action.DUCK,SpeechAudioFocusPolicy.Mode.IN_CALL),"ducking never stops capture");

  // Per-chunk validation of the native stream.
  SpeechStreamValidation valid=new SpeechStreamValidation();valid.accept(tone(24_000,.2f),false);valid.accept(new float[0],true);
  check(valid.complete&&valid.samples==24_000,"a valid stream completes");
  for(float[] bad:new float[][]{{Float.NaN},{Float.POSITIVE_INFINITY},new float[24_001]}){
   try{new SpeechStreamValidation().accept(bad,false);throw new AssertionError("invalid chunk accepted");}catch(IllegalStateException expected){/* rejected */}
  }
  try{SpeechStreamValidation quietStream=new SpeechStreamValidation();quietStream.accept(tone(4_800,0f),true);throw new AssertionError("silent accepted");}catch(IllegalStateException expected){check("Speech output is silent".equals(expected.getMessage()),"silent message");}
  try{new SpeechStreamValidation().accept(tone(100,.3f),true);throw new AssertionError("too short accepted");}catch(IllegalStateException expected){/* rejected */}
  try{SpeechStreamValidation done=new SpeechStreamValidation();done.accept(tone(2_400,.3f),true);done.accept(tone(10,.3f),false);throw new AssertionError("chunk after completion");}catch(IllegalStateException expected){/* rejected */}
  System.out.println("PASS streaming speech");
 }
}
