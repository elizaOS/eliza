package ai.eliza.plugins.agent.updater;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
public final class JobRunRegistryTest {
 static int assertions;
 static void check(boolean value){assertions++;if(!value)throw new AssertionError();}
 static final class Queue implements Executor {
  final java.util.Queue<Runnable> tasks=new ArrayDeque<>();
  public void execute(Runnable action){tasks.add(action);}
  void drain(){while(!tasks.isEmpty())tasks.remove().run();}
 }
 public static void main(String[] args)throws Exception {
  Queue work=new Queue(),main=new Queue();JobRunRegistry runs=new JobRunRegistry(work,main);
  List<Boolean> finishes=new ArrayList<>();AtomicInteger effects=new AtomicInteger();
  runs.start(1,c->{effects.incrementAndGet();return false;},finishes::add);check(runs.size()==1);work.drain();check(finishes.isEmpty());main.drain();check(finishes.equals(List.of(false)));check(runs.size()==0);
  runs.start(1,c->{effects.incrementAndGet();return false;},finishes::add);runs.stop(1);work.drain();main.drain();check(effects.get()==1);check(finishes.size()==1);
  runs.start(1,c->false,finishes::add);work.drain();runs.stop(1);main.drain();check(finishes.size()==1);check(runs.size()==0);
  runs.start(1,c->false,finishes::add);work.drain();runs.start(1,c->true,finishes::add);main.drain();check(finishes.size()==1);check(runs.size()==1);work.drain();main.drain();check(finishes.equals(List.of(false,true)));check(runs.size()==0);
  runs.start(1,c->{throw new Exception("failure");},finishes::add);work.drain();main.drain();check(finishes.get(2));check(runs.size()==0);
  runs.start(1,c->false,finishes::add);runs.start(2,c->false,finishes::add);work.drain();runs.close();runs.close();main.drain();check(finishes.size()==3);check(runs.size()==0);
  try{runs.start(3,c->false,finishes::add);throw new AssertionError();}catch(IllegalStateException expected){assertions++;}
  AtomicInteger closes=new AtomicInteger();JobRunRegistry.Cancellation late=new JobRunRegistry.Cancellation();late.cancel();late.onCancel(closes::incrementAndGet);late.cancel();check(closes.get()==1);
  JobRunRegistry rejected=new JobRunRegistry(action->{throw new RejectedExecutionException();},main);rejected.start(4,c->false,finishes::add);main.drain();check(finishes.size()==4&&finishes.get(3));check(rejected.size()==0);
  // Real worker cancellation closes resources and suppresses a completion even
  // when work ignores the interrupt and eventually returns successfully.
  ExecutorService pool=Executors.newSingleThreadExecutor();Queue completion=new Queue();
  JobRunRegistry active=new JobRunRegistry(pool,completion);
  CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1),exited=new CountDownLatch(1);
  AtomicInteger notified=new AtomicInteger();
  try {
   active.start(7,c->{c.onCancel(closes::incrementAndGet);entered.countDown();while(true){try{release.await();break;}catch(InterruptedException ignored){}}exited.countDown();return false;},retry->notified.incrementAndGet());
   check(entered.await(2,TimeUnit.SECONDS));active.stop(7);check(closes.get()==2);release.countDown();check(exited.await(2,TimeUnit.SECONDS));pool.shutdown();check(pool.awaitTermination(2,TimeUnit.SECONDS));completion.drain();check(notified.get()==0);check(active.size()==0);
  } finally {release.countDown();active.close();pool.shutdownNow();}
  System.out.println("JobRunRegistry: "+assertions+" assertions passed");
 }
}
