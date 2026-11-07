package ai.eliza.sense;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
public final class ListeningEpochTest {
 private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  ListeningEpoch epoch=new ListeningEpoch();check(!epoch.current(epoch.ticket()),"off has no authority");
  epoch.renew(true);long before=epoch.ticket();check(epoch.current(before),"active session");
  CountDownLatch recognizing=new CountDownLatch(1),finish=new CountDownLatch(1);
  AtomicBoolean dispatched=new AtomicBoolean();
  Thread worker=new Thread(()->{recognizing.countDown();try{finish.await();}catch(InterruptedException e){throw new RuntimeException(e);}if(epoch.current(before))dispatched.set(true);});
  worker.start();check(recognizing.await(5,TimeUnit.SECONDS),"recognition started");
  epoch.invalidate();check(!epoch.current(before),"stop invalidates in-flight work");
  epoch.renew(true);long after=epoch.ticket();finish.countDown();worker.join(5000);
  check(!worker.isAlive()&&!dispatched.get(),"resume cannot authorize old recognition");
  check(epoch.current(after),"fresh recognition remains available");
  Runnable mainCallback=()->{if(epoch.current(after))dispatched.set(true);};
  epoch.invalidate();epoch.renew(true);mainCallback.run();check(!dispatched.get(),"queued UI callback expires across pause/resume");
  long playback=epoch.ticket();epoch.invalidate();epoch.renew(true);check(!epoch.current(playback),"playback suppression invalidates prior speech");
  epoch.renew(false);check(!epoch.current(epoch.ticket()),"disabled renewal has no authority");
  System.out.println("PASS listener session authority");
 }
}
