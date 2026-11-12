package ai.eliza.voice;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * JVM contract for sentences appended to one streamed utterance: order, one end report, late and
 * abandoned segments, cancellation, and the queued admission behind it. A fake output stands in for
 * the AudioTrack; this is not device audio evidence.
 */
public final class SpeechAppendTest {
 private static void check(boolean ok,String what){if(!ok)throw new AssertionError(what);}
 private static float[] fill(int n,float v){float[] out=new float[n];java.util.Arrays.fill(out,v);return out;}
 private static void until(java.util.function.BooleanSupplier done,String what)throws Exception{
  long end=System.nanoTime()+2_000_000_000L;
  while(!done.getAsBoolean()){check(System.nanoTime()<end,what);Thread.sleep(2);}
 }
 /** Plays what was written at once, or only up to {@code limit} frames while one is set. */
 private static final class Out implements StreamingSpeechPlayback.Output {
  final List<Float> heard=new ArrayList<>();
  final AtomicInteger aborts=new AtomicInteger(),stops=new AtomicInteger(),releases=new AtomicInteger(),plays=new AtomicInteger();
  volatile long written;volatile long limit=-1;
  public void play(){plays.incrementAndGet();}
  public synchronized int write(float[] samples,int offset,int length){for(int i=offset;i<offset+length;i++)heard.add(samples[i]);written+=length;return length;}
  public long playedFrames(){long cap=limit;return cap<0?written:Math.min(cap,written);}
  public long presentationNs(long frame){return VoiceLatencyTrials.UNSET;}
  public void setVolume(float volume){}
  public void abort(){aborts.incrementAndGet();}
  public void stop(){stops.incrementAndGet();}
  public void release(){releases.incrementAndGet();}
  synchronized int count(float value){int n=0;for(float sample:heard)if(sample==value)n++;return n;}
  synchronized float at(int index){return heard.get(index);}
 }
 private static final class Events implements StreamingSpeechPlayback.Listener {
  final AtomicInteger first=new AtomicInteger(),ended=new AtomicInteger(),failed=new AtomicInteger();
  public void firstFrame(long nanos){first.incrementAndGet();}
  public void audible(long nanos,String clock){}
  public void ended(boolean silent){check(!silent,"speech was heard");ended.incrementAndGet();}
  public void failed(String reason){failed.incrementAndGet();}
 }
 private static StreamingSpeechPlayback playback(Out out,Events events){return new StreamingSpeechPlayback(48_000,24_000,.01f,()->out,events,System::nanoTime);}

 public static void main(String[] args)throws Exception{
  // A second sentence arrives while the first is still playing: same output, in order, one end.
  Out out=new Out();Events events=new Events();out.limit=0;
  StreamingSpeechPlayback speech=playback(out,events);
  check(speech.offer(fill(480,.1f),true),"the first sentence is queued and complete");
  speech.start();
  until(()->out.written==480,"the first sentence reaches the output");
  check(!speech.audible(),"nothing has played yet");
  out.limit=100;
  check(speech.audible()&&speech.pendingFrames()==380,"speech is audible while offered audio remains");
  check(!speech.finished()&&speech.extend(),"a playing utterance accepts the next sentence");
  long[] reached={-1,-1};AtomicInteger marks=new AtomicInteger();
  speech.mark((nanos,buffered)->{marks.incrementAndGet();reached[0]=out.written;reached[1]=buffered;});
  check(speech.offer(fill(480,.2f),false)&&speech.offer(fill(240,.2f),true),"the second sentence follows in the same queue");
  until(()->out.written==1200,"the second sentence reaches the same output");
  check(marks.get()==1&&reached[0]==480&&reached[1]==380,"its first frame is reported once, behind the 380 frames still to play");
  check(events.ended.get()==0,"the utterance has not ended while audio remains");
  out.limit=-1;
  check(speech.join(3000),"the writer exits");
  check(events.ended.get()==1&&events.failed.get()==0&&events.first.get()==1,"one end, one first frame, no failure");
  check(out.plays.get()==1&&out.stops.get()==1&&out.releases.get()==1,"one output for both sentences");
  check(out.count(.1f)==480&&out.count(.2f)==720&&out.at(479)==.1f&&out.at(480)==.2f,"the sentences play in order, without a gap");
  check(speech.finished()&&!speech.extend()&&!speech.audible(),"an ended utterance accepts nothing more");

  // A reserved sentence that is slow keeps the utterance open after the first one played out; abandoning it ends it.
  Out late=new Out();Events lateEvents=new Events();
  StreamingSpeechPlayback waiting=playback(late,lateEvents);
  check(waiting.extend(),"reserved before the first sentence completes");
  waiting.offer(fill(480,.1f),true);waiting.start();
  until(()->late.written==480,"the first sentence plays out");
  Thread.sleep(80);
  check(lateEvents.ended.get()==0&&!waiting.finished(),"the utterance waits for its reserved sentence");
  check(waiting.offer(fill(480,.3f),false),"the late sentence still joins it");
  until(()->late.written==960,"the late sentence plays");
  check(waiting.extend(),"and a third is reserved");
  check(waiting.offer(new float[0],true),"the second completes");
  Thread.sleep(40);
  check(lateEvents.ended.get()==0,"still waiting for the third");
  waiting.abandon();
  check(waiting.join(3000)&&lateEvents.ended.get()==1&&lateEvents.failed.get()==0,"abandoning the last reserved sentence ends the utterance once");
  check(late.count(.1f)==480&&late.count(.3f)==480&&late.releases.get()==1,"what was offered was played");

  // A sentence reserved while the last one drains, then abandoned without audio.
  Out drain=new Out();Events drainEvents=new Events();drain.limit=0;
  StreamingSpeechPlayback draining=playback(drain,drainEvents);
  draining.offer(fill(480,.1f),true);draining.start();
  until(()->drain.written==480,"queued");
  check(draining.extend(),"reserved during the drain");
  draining.abandon();drain.limit=-1;
  check(draining.join(3000)&&drainEvents.ended.get()==1&&drainEvents.failed.get()==0,"the utterance still ends once");

  // Stop (barge-in) drops every queued sentence and reports nothing.
  Out cut=new Out();Events cutEvents=new Events();cut.limit=0;
  StreamingSpeechPlayback stopped=playback(cut,cutEvents);
  stopped.offer(fill(480,.1f),true);stopped.start();
  until(()->cut.written==480,"queued");
  check(stopped.extend()&&stopped.offer(fill(24_000,.2f),false)&&stopped.offer(fill(24_000,.2f),false),"a second sentence is queued");
  stopped.stop();
  float[] refused=fill(480,.2f);
  check(!stopped.offer(refused,true)&&refused[0]==0f,"a stopped utterance refuses and clears further audio");
  check(!stopped.extend()&&!stopped.audible()&&stopped.queuedSamples()==0,"and reserves nothing");
  check(stopped.join(3000)&&cutEvents.ended.get()==0&&cutEvents.failed.get()==0,"stop is silent: no end, no failure");
  check(cut.aborts.get()>=1&&cut.releases.get()==1&&cut.stops.get()==0,"the output is aborted and released");

  // Admission: appended sentences wait behind the running one, a bounded few; others still run alone.
  SpeechRequestGate gate=new SpeechRequestGate();
  SpeechRequestGate.Request a=gate.admit("a",true,true).request;
  check(a!=null,"an append with nothing running is admitted like any request");
  check(gate.admit("x",true).request==null&&gate.admit("x",false).refusal==SpeechRequestGate.Refusal.BUSY,"a plain request still never queues");
  SpeechRequestGate.Request b=gate.admit("b",true,true).request;
  check(b!=null&&gate.admit("b",true,true).refusal==SpeechRequestGate.Refusal.UNAVAILABLE,"an append queues once");
  SpeechRequestGate.Request c=gate.admit("c",true,true).request;
  check(c!=null&&gate.admit("d",true,true).refusal==SpeechRequestGate.Refusal.BUSY,"at most three at once; the next is refused as busy");
  gate.settle(a);
  check(gate.admit("d",true,true).request!=null,"a settled request makes room");
  gate.cancelAll();
  check(b.cancelled&&c.cancelled,"cancelling everything reaches the queued sentences");
  gate.destroy();
  check(gate.admit("e",true,true).request==null,"nothing queues after destroy");
  System.out.println("PASS speech append order, single end, late and abandoned sentences, stop and queued admission");
 }
}
