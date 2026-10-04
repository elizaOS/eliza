package ai.eliza.plugins.agent.updater;

import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

/** Per-service execution tickets fence late completion after stop/replacement.
 * Completion is dispatched to the lifecycle executor (Android's main thread).
 * Work must check cancellation before side effects; interruption alone cannot
 * undo a platform commit. No job identity or recovery state is persisted here. */
public class JobRunRegistry implements AutoCloseable {
 public interface Work { boolean run(Cancellation cancellation)throws Exception; }
 public static final class Cancellation {
  private boolean cancelled;
  private Runnable hook;
  public synchronized boolean isCancelled(){return cancelled;}
  // Hook must be nonblocking, e.g. closing the native HTTP session. Registering
  // after stop immediately closes the newly created resource as well.
  public void onCancel(Runnable value){
   boolean close;
   synchronized(this){if(hook!=null)throw new IllegalStateException("Cancellation hook already registered");hook=Objects.requireNonNull(value);close=cancelled;}
   if(close)value.run();
  }
  public void cancel(){
   Runnable close;
   synchronized(this){if(cancelled)return;cancelled=true;close=hook;}
   if(close!=null)close.run();
  }
 }
 private final Executor workers,lifecycle;
 private final Map<Integer,Run> running=new HashMap<>();
 private boolean closed;
 private static final class Run {
  final Cancellation cancellation=new Cancellation();
  FutureTask<Void> task;
 }
 public JobRunRegistry(Executor workers,Executor lifecycle){this.workers=workers;this.lifecycle=lifecycle;}
 public synchronized void start(int id,Work work,Consumer<Boolean> finish){
  if(closed)throw new IllegalStateException("Job service destroyed");
  Run run=new Run();Run old=running.put(id,run);if(old!=null)cancel(old);
  run.task=new FutureTask<>(()->{
   boolean retry=true;
   try{if(!run.cancellation.isCancelled())retry=work.run(run.cancellation);}
   catch(Exception failure){retry=true;}
   final boolean result=retry;
   lifecycle.execute(()->complete(id,run,result,finish));
   return null;
  });
  try{workers.execute(run.task);}
  catch(RejectedExecutionException failure){lifecycle.execute(()->complete(id,run,true,finish));}
 }
 private synchronized void complete(int id,Run run,boolean retry,Consumer<Boolean> finish){
  if(closed||running.get(id)!=run||run.cancellation.isCancelled())return;
  running.remove(id);finish.accept(retry);
 }
 public synchronized void stop(int id){Run run=running.remove(id);if(run!=null)cancel(run);}
 public synchronized int size(){return running.size();}
 @Override public synchronized void close(){
  if(closed)return;closed=true;
  for(Run run:running.values())cancel(run);running.clear();
 }
 private static void cancel(Run run){
  // Interrupt even if a resource-specific close operation fails.
  try{run.cancellation.cancel();}catch(RuntimeException ignored){}
  finally{if(run.task!=null)run.task.cancel(true);}
 }
}
