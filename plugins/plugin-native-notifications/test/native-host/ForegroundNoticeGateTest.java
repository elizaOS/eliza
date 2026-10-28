import ai.eliza.plugins.notifications.ForegroundNoticeGate;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** JVM checks of the foreground notice gate with a synthetic main thread and activity. No Android framework. */
public final class ForegroundNoticeGateTest {
 private static int checks;
 private static void check(boolean value){checks++;if(!value)throw new AssertionError("Check "+checks);}
 private interface Failing{void run()throws Exception;}
 private static void rejects(Failing action)throws Exception{checks++;try{action.run();}catch(IllegalStateException|IllegalArgumentException expected){return;}throw new AssertionError("Expected refusal at check "+checks);}

 /** A single-thread main loop; post can be made to fail or to drop its task. */
 static final class Main implements ForegroundNoticeGate.MainThread{
  final ExecutorService loop=Executors.newSingleThreadExecutor();volatile Thread thread;volatile boolean refuse,drop;final List<Runnable> removed=new ArrayList<>();
  Main()throws Exception{loop.submit(()->{thread=Thread.currentThread();}).get();}
  public boolean isCurrent(){return Thread.currentThread()==thread;}
  public boolean post(Runnable check){if(refuse)return false;if(!drop)loop.execute(check);return true;}
  public synchronized void remove(Runnable check){removed.add(check);}
 }
 static final class Activity implements ForegroundNoticeGate.Foreground{
  volatile boolean focused=true,locked;volatile Thread checkedOn;
  public void check(){checkedOn=Thread.currentThread();if(!focused||locked)throw new IllegalStateException();}
 }
 static final class Replies implements ForegroundNoticeGate.Refusal{
  final LinkedBlockingQueue<String> failures=new LinkedBlockingQueue<>();
  public void reject(String failure){failures.add(failure);}
 }

 public static void main(String[] args)throws Exception{
  Main main=new Main();Activity activity=new Activity();ExecutorService worker=Executors.newSingleThreadExecutor();
  rejects(()->new ForegroundNoticeGate(null,activity,worker));
  rejects(()->new ForegroundNoticeGate(main,activity,worker,0));
  ForegroundNoticeGate gate=new ForegroundNoticeGate(main,activity,worker,200);

  // The check runs on main; work runs on the worker only while the host is in the foreground.
  Replies replies=new Replies();AtomicInteger ran=new AtomicInteger();AtomicBoolean onWorker=new AtomicBoolean();
  check(gate.submit("unavailable",replies,()->{onWorker.set(!main.isCurrent());ran.incrementAndGet();}));
  worker.submit(()->{}).get();
  check(ran.get()==1&&onWorker.get()&&activity.checkedOn==main.thread&&replies.failures.isEmpty());

  // Locked, unfocused, destroyed: refused with the host's failure text and nothing runs.
  activity.locked=true;gate.submit("Unlock to continue",replies,ran::incrementAndGet);
  check("Unlock to continue".equals(replies.failures.poll(5,TimeUnit.SECONDS))&&ran.get()==1);
  activity.locked=false;activity.focused=false;gate.submit("Unfocused",replies,ran::incrementAndGet);
  check("Unfocused".equals(replies.failures.poll(5,TimeUnit.SECONDS))&&ran.get()==1);
  activity.focused=true;

  // Work that fails, or is interrupted, answers once with the failure; the interrupt is restored.
  gate.submit("Failed",replies,()->{throw new IllegalStateException("disk");});
  check("Failed".equals(replies.failures.poll(5,TimeUnit.SECONDS)));
  AtomicBoolean interrupted=new AtomicBoolean();
  gate.submit("Interrupted",failure->{interrupted.set(Thread.currentThread().isInterrupted());replies.reject(failure);},()->{throw new InterruptedException();});
  check("Interrupted".equals(replies.failures.poll(5,TimeUnit.SECONDS))&&interrupted.get());
  check(replies.failures.isEmpty());

  // require() refuses on the main thread itself, when post fails and when the check never runs.
  rejects(()->{try{main.loop.submit(()->{gate.require();return null;}).get();}catch(java.util.concurrent.ExecutionException e){throw (Exception)e.getCause();}});
  main.refuse=true;rejects(gate::require);main.refuse=false;
  main.drop=true;rejects(gate::require);check(main.removed.size()==1);main.drop=false;
  gate.require();

  // Destroyed: every later check refuses.
  gate.destroy();check(gate.destroyed());rejects(gate::require);
  gate.submit("Destroyed",replies,ran::incrementAndGet);
  check("Destroyed".equals(replies.failures.poll(5,TimeUnit.SECONDS))&&ran.get()==1);

  // A stopped worker answers on the calling thread instead of throwing.
  ForegroundNoticeGate live=new ForegroundNoticeGate(main,activity,worker,200);
  worker.shutdown();worker.awaitTermination(5,TimeUnit.SECONDS);
  boolean accepted=true;try{accepted=live.submit("Stopped",replies,ran::incrementAndGet);}catch(RejectedExecutionException thrown){throw new AssertionError("worker refusal escaped");}
  check(!accepted&&"Stopped".equals(replies.failures.poll())&&ran.get()==1);

  main.loop.shutdownNow();
  System.out.println(checks+" assertions passed");
 }
}
