package ai.eliza.plugins.notifications;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Foreground fence for a host's notice work. Notice storage, receipts and question excerpts are
 * read on the host's notice worker, never on the main thread, and only while the host's activity
 * is in the foreground (focused, not finishing, device unlocked) and its plugin is not destroyed.
 * The foreground check itself runs on the main thread: {@link #require()} posts it there and waits
 * a bounded time for the answer. A host checks again after each read that may have blocked, so a
 * lock or pause during that read refuses the result instead of returning it.
 *
 * <p>No Android types: the host supplies its main thread (a Handler on the main Looper) and its
 * activity check. A worker that refuses the work (stopped on destroy, or full) answers the call
 * with its failure instead of throwing on the bridge thread.
 */
public final class ForegroundNoticeGate {
 /** The host's main thread. */
 public interface MainThread {
  /** True when the calling thread is the main thread. */
  boolean isCurrent();
  /** Queues the check on the main thread; false when it cannot run (the looper is quitting). */
  boolean post(Runnable check);
  /** Removes a queued check that timed out. */
  void remove(Runnable check);
 }
 /** Throws unless the host activity is in the foreground: focused, not finishing, unlocked. Runs on main. */
 public interface Foreground {void check()throws Exception;}
 /** Notice work run on the worker once the gate admits it. */
 public interface Work {void run()throws Exception;}
 /** Answers a refused call with the host's owner-facing failure text. */
 public interface Refusal {void reject(String failure);}

 public static final long DEFAULT_TIMEOUT_MS=5000;
 private final MainThread main;
 private final Foreground foreground;
 private final Executor worker;
 private final long timeoutMs;
 private volatile boolean destroyed;

 public ForegroundNoticeGate(MainThread main,Foreground foreground,Executor worker){this(main,foreground,worker,DEFAULT_TIMEOUT_MS);}
 public ForegroundNoticeGate(MainThread main,Foreground foreground,Executor worker,long timeoutMs){
  if(main==null||foreground==null||worker==null||timeoutMs<=0)throw new IllegalArgumentException("Invalid foreground notice gate");
  this.main=main;this.foreground=foreground;this.worker=worker;this.timeoutMs=timeoutMs;
 }

 /** The host plugin was destroyed: every later check refuses. */
 public void destroy(){destroyed=true;}
 public boolean destroyed(){return destroyed;}

 /** Off the main thread only: throws unless the host is in the foreground right now. */
 public void require()throws Exception{
  if(main.isCurrent())throw new IllegalStateException("Notice storage must not run on the main thread");
  if(destroyed)throw new IllegalStateException("Notice host destroyed");
  CountDownLatch checked=new CountDownLatch(1);
  AtomicBoolean admitted=new AtomicBoolean();
  Runnable check=()->{try{if(!destroyed){foreground.check();admitted.set(true);}}catch(Exception inactive){/* refused below */}finally{checked.countDown();}};
  if(!main.post(check))throw new IllegalStateException("Notice host unavailable");
  if(!checked.await(timeoutMs,TimeUnit.MILLISECONDS)){main.remove(check);throw new IllegalStateException("Notice host check timed out");}
  if(!admitted.get()||destroyed)throw new IllegalStateException("Notice host inactive");
 }

 /**
  * Runs work on the notice worker behind the foreground check. Any refusal or failure, including
  * the worker refusing the task, answers once with failure; an interrupt is restored on the worker.
  * Work that resolves the call itself checks {@link #require()} again after any read that may block.
  * @return true when the worker accepted the work
  */
 public boolean submit(String failure,Refusal refusal,Work work){
  Runnable task=()->{
   try{require();work.run();}
   catch(InterruptedException interrupted){Thread.currentThread().interrupt();refusal.reject(failure);}
   catch(Exception unavailable){refusal.reject(failure);}
  };
  try{worker.execute(task);return true;}
  catch(RejectedExecutionException stopped){refusal.reject(failure);return false;}
 }
}
