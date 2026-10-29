package ai.eliza.plugins.notifications;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Bounded FIFO worker for a host's durable notice work (receipts, routes, question excerpts).
 * One thread, so storage writes keep their submission order; it never runs work on the caller.
 * A full queue or a closed worker refuses with {@link RejectedExecutionException}; use
 * {@link #submit} to answer that refusal instead of throwing on a bridge thread.
 */
public final class NoticeWorker implements AutoCloseable, Executor {
 public static final int DEFAULT_CAPACITY=512;
 private final ThreadPoolExecutor executor;
 public NoticeWorker(){this(DEFAULT_CAPACITY,"eliza-notice-storage");}
 public NoticeWorker(int capacity,String threadName){
  if(capacity<1||threadName==null||threadName.isBlank())throw new IllegalArgumentException("Invalid notice worker");
  executor=new ThreadPoolExecutor(1,1,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(capacity),task->{Thread thread=new Thread(task,threadName);thread.setDaemon(true);return thread;},new ThreadPoolExecutor.AbortPolicy());
  executor.allowCoreThreadTimeOut(true);
 }
 @Override public void execute(Runnable task){executor.execute(task);}
 @Override public void close(){executor.shutdownNow();}
 /** True when the worker accepted the work; otherwise refused has run on the calling thread. */
 public static boolean submit(Executor worker,Runnable work,Runnable refused){
  try{worker.execute(work);return true;}
  catch(RejectedExecutionException stopped){refused.run();return false;}
 }
}
