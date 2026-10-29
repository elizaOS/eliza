import ai.eliza.plugins.notifications.NoticeIds;
import ai.eliza.plugins.notifications.NoticeWorker;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** JVM checks of the host plugin's opaque identifiers, bounds and bounded notice worker. No Android framework. */
public final class NoticeIdsTest {
 private static int checks;
 private static void check(boolean value){checks++;if(!value)throw new AssertionError("Check "+checks);}

 public static void main(String[] args)throws Exception{
  NoticeIds ids=new NoticeIds();
  String first=ids.id("key-a\n1"),again=ids.id("key-a\n1"),other=ids.id("key-b\n2");
  check(first.equals(again));check(!first.equals(other));
  check(!first.contains("key-a"));
  check("key-a\n1".equals(ids.key(first)));
  check(ids.names(first,"key-a\n1"));check(!ids.names(other,"key-a\n1"));
  check(ids.key(null)==null&&ids.key("")==null&&ids.key("unknown")==null);
  // A row that disappears is forgotten; its identifier no longer resolves, even if the key reappears.
  ids.retain(List.of("key-b\n2"));
  check(ids.key(first)==null);check(other.equals(ids.id("key-b\n2")));
  check(!first.equals(ids.id("key-a\n1")));
  // Pause invalidates every identifier the renderer holds.
  ids.clear();check(ids.key(other)==null);check(!ids.names(other,"key-b\n2"));

  check(NoticeIds.bounded(null,5).isEmpty());
  check(NoticeIds.bounded("abc",5).equals("abc"));
  check(NoticeIds.bounded("abcdef",5).equals("abcde"));
  // A surrogate pair straddling the bound is dropped whole, never split.
  String emoji="abcd😀";
  check(NoticeIds.bounded(emoji,5).equals("abcd"));
  check(NoticeIds.bounded(emoji,6).equals(emoji));
  check(NoticeIds.bounded("abc",0).isEmpty());check(NoticeIds.bounded("",0).isEmpty());

  try{new NoticeWorker(0,"x");check(false);}catch(IllegalArgumentException expected){check(true);}
  try{new NoticeWorker(1," ");check(false);}catch(IllegalArgumentException expected){check(true);}
  // FIFO on one named daemon thread, never on the caller.
  try(NoticeWorker worker=new NoticeWorker(4,"notice-test")){
   List<String> order=new CopyOnWriteArrayList<>();CountDownLatch done=new CountDownLatch(3);Thread caller=Thread.currentThread();AtomicBoolean onCaller=new AtomicBoolean();
   for(String step:new String[]{"a","b","c"})worker.execute(()->{if(Thread.currentThread()==caller)onCaller.set(true);check(Thread.currentThread().getName().equals("notice-test")&&Thread.currentThread().isDaemon());order.add(step);done.countDown();});
   check(done.await(5,TimeUnit.SECONDS));check(order.equals(List.of("a","b","c")));check(!onCaller.get());
  }
  // A full queue refuses instead of growing; submit answers the refusal on the caller.
  try(NoticeWorker worker=new NoticeWorker(1,"notice-full")){
   CountDownLatch release=new CountDownLatch(1),started=new CountDownLatch(1);
   worker.execute(()->{started.countDown();try{release.await();}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}});
   check(started.await(5,TimeUnit.SECONDS));
   worker.execute(()->{});
   try{worker.execute(()->{});check(false);}catch(RejectedExecutionException expected){check(true);}
   AtomicBoolean refused=new AtomicBoolean();
   check(!NoticeWorker.submit(worker,()->{},()->refused.set(true)));check(refused.get());
   release.countDown();
  }
  // A closed worker (plugin destroyed) refuses too.
  NoticeWorker closed=new NoticeWorker(2,"notice-closed");closed.close();
  AtomicBoolean refused=new AtomicBoolean();
  check(!NoticeWorker.submit(closed,()->{throw new AssertionError("ran after close");},()->refused.set(true)));check(refused.get());
  System.out.println(checks+" assertions passed");
 }
}
