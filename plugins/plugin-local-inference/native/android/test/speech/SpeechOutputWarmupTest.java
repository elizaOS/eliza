package ai.eliza.voice;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/** JVM contract for the bounded, cancellable speech output warm-up; no Android classes are involved. */
public final class SpeechOutputWarmupTest {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 private static void await(CountDownLatch latch)throws Exception{check(latch.await(2,TimeUnit.SECONDS),"worker did not settle");}
 private static class Output implements StreamingSpeechPlayback.Output {
  final AtomicInteger plays=new AtomicInteger(),writes=new AtomicInteger(),aborts=new AtomicInteger(),releases=new AtomicInteger();
  final CountDownLatch entered=new CountDownLatch(1),released=new CountDownLatch(1),unblocked=new CountDownLatch(1);
  final AtomicLong clock=new AtomicLong();
  boolean block,fail,empty;
  public void play(){plays.incrementAndGet();}
  public int write(float[] samples,int offset,int length){
   writes.incrementAndGet();entered.countDown();
   check(length==480,"20 ms chunks at 24 kHz");
   for(float sample:samples)check(sample==0,"warmup must contain only silence");
   if(fail)throw new IllegalStateException("output lost");
   if(block)try{unblocked.await();}catch(InterruptedException stopped){Thread.currentThread().interrupt();}
   clock.addAndGet(20_000_000L);
   return empty?0:length;
  }
  public long playedFrames(){return 0;}
  public long presentationNs(long frame){return -1;}
  public void setVolume(float volume){}
  public void abort(){aborts.incrementAndGet();unblocked.countDown();}
  public void stop(){}
  public void release(){releases.incrementAndGet();released.countDown();}
 }
 public static void main(String[] args)throws Exception{
  Output bounded=new Output();new SpeechOutputWarmup(24000,()->bounded,bounded.clock::get);
  await(bounded.released);
  check(bounded.plays.get()==1&&bounded.writes.get()==750,"warmup has a 15 second bound");
  check(bounded.releases.get()==1,"bounded output released once");

  Output blocked=new Output();blocked.block=true;
  SpeechOutputWarmup active=new SpeechOutputWarmup(24000,()->blocked,blocked.clock::get);
  await(blocked.entered);active.close();active.close();await(blocked.released);
  check(blocked.aborts.get()>=1&&blocked.releases.get()==1,"close unblocks and releases output once");
  check(blocked.writes.get()==1,"closed warmup never writes another chunk");

  Output late=new Output();CountDownLatch opening=new CountDownLatch(1),continueOpen=new CountDownLatch(1);
  SpeechOutputWarmup pending=new SpeechOutputWarmup(24000,()->{
   opening.countDown();
   boolean interrupted=false;
   for(;;)try{continueOpen.await();break;}catch(InterruptedException stopped){interrupted=true;}
   if(interrupted)Thread.currentThread().interrupt();return late;
  },late.clock::get);
  await(opening);pending.close();continueOpen.countDown();await(late.released);
  check(late.plays.get()==0&&late.writes.get()==0,"late open after close never starts playback");
  check(late.releases.get()==1,"late output is released");

  CountDownLatch playing=new CountDownLatch(1),continuePlay=new CountDownLatch(1),closeDone=new CountDownLatch(1);
  boolean[] restartedAfterAbort={false};
  Output crossing=new Output(){
   @Override public void play(){
    playing.countDown();
    try{continuePlay.await();}catch(InterruptedException stopped){Thread.currentThread().interrupt();}
    restartedAfterAbort[0]=aborts.get()>0;
    super.play();
   }
  };
  crossing.block=true;
  SpeechOutputWarmup crossingWarmup=new SpeechOutputWarmup(24000,()->crossing,crossing.clock::get);
  await(playing);
  Thread closing=new Thread(()->{crossingWarmup.close();closeDone.countDown();});closing.start();
  long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);
  while(closing.getState()!=Thread.State.BLOCKED&&closeDone.getCount()!=0&&System.nanoTime()<deadline)Thread.yield();
  check(closing.getState()==Thread.State.BLOCKED||closeDone.getCount()==0,"close did not reach the play boundary");
  continuePlay.countDown();await(closeDone);await(crossing.released);
  check(!restartedAfterAbort[0],"play must never restart an output aborted by close");

  Output failed=new Output();failed.fail=true;
  new SpeechOutputWarmup(24000,()->failed,failed.clock::get);await(failed.released);
  check(failed.writes.get()==1&&failed.releases.get()==1,"write failure retires warmup");

  Output stalled=new Output();stalled.empty=true;
  new SpeechOutputWarmup(24000,()->stalled,stalled.clock::get);await(stalled.released);
  check(stalled.writes.get()==1,"zero writes do not spin");
  System.out.println("PASS output warmup bounded silence, cancellation, late open and failure");
 }
}
