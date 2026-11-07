package ai.eliza.plugins.securestore.nativeonly;

import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import static org.junit.Assert.*;

public final class NativeDeadlineTimerInstrumentedTest {
  private static final class Queue implements NativeDeadlineTimer.Dispatcher {
    Runnable queued; long delay; boolean accepting=true;
    public boolean post(Runnable callback,long delay){this.queued=callback;this.delay=delay;return accepting;}
    public void remove(Runnable callback){if(queued==callback)queued=null;}
  }
  private void main(Runnable work){InstrumentationRegistry.getInstrumentation().runOnMainSync(work);}

  @Test public void absoluteExpiryRejectsEarlyAndStaleCallbacks() { main(()->{
    long[] now={100};int[] calls={0};Queue queue=new Queue();
    try(NativeDeadlineTimer timer=new NativeDeadlineTimer(()->now[0],queue)) {
      timer.after(15000,()->calls[0]++);Runnable stale=queue.queued;
      now[0]+=5000;stale.run();assertEquals(10000,queue.delay);assertEquals(0,calls[0]);
      timer.after(15000,()->calls[0]+=10);Runnable current=queue.queued;
      stale.run();assertSame(current,queue.queued);assertEquals(0,calls[0]);
      now[0]+=15000;timer.refresh();assertEquals(10,calls[0]);assertNull(queue.queued);
      current.run();assertEquals(10,calls[0]);
      timer.after(15000,()->calls[0]++);Runnable cancelled=queue.queued;timer.cancel();cancelled.run();assertEquals(10,calls[0]);
    }
  }); }

  @Test public void destructionAndReentrantDestinationsCannotResurrectOldWork() { main(()->{
    long[] now={0};int[] calls={0};Queue queue=new Queue();
    NativeDeadlineTimer timer=new NativeDeadlineTimer(()->now[0],queue);
    timer.after(10,()->{calls[0]++;timer.after(20,()->calls[0]+=10);});Runnable old=queue.queued;
    now[0]=10;old.run();assertEquals(1,calls[0]);Runnable next=queue.queued;
    old.run();assertSame(next,queue.queued);assertEquals(1,calls[0]);
    timer.close();next.run();assertEquals(1,calls[0]);assertNull(queue.queued);
    try{timer.after(1,()->calls[0]++);fail("Closed timer armed");}catch(IllegalStateException expected){}
    timer.refresh();assertEquals(1,calls[0]);
  }); }

  @Test public void invalidClockAndUnavailableDispatcherExpireWithoutOverflow() { main(()->{
    long[] now={Long.MAX_VALUE-2};int[] calls={0};Queue queue=new Queue();
    try(NativeDeadlineTimer timer=new NativeDeadlineTimer(()->now[0],queue)) {
      timer.after(Long.MAX_VALUE,()->calls[0]++);assertEquals(Integer.MAX_VALUE,queue.delay);
      now[0]=Long.MAX_VALUE;timer.refresh();assertEquals(0,calls[0]);
      now[0]=0;timer.refresh();assertEquals(1,calls[0]);
      now[0]=-1;timer.after(10,()->calls[0]++);assertEquals(2,calls[0]);
      now[0]=10;queue.accepting=false;timer.after(10,()->calls[0]++);assertEquals(3,calls[0]);
      queue.queued.run();assertEquals(3,calls[0]);
    }
  }); }

  @Test public void autofillDeadlineUsesOriginalRequestAgeAndRevocation() { main(()->{
    long[] now={100};Queue queue=new Queue();int[] expired={0};
    PasswordAutofillSessions.Session session=new PasswordAutofillSessions.Session(null,()->now[0]);
    now[0]+=110000;assertEquals(10000,session.remainingMillis());
    try(NativeDeadlineTimer timer=new NativeDeadlineTimer(()->now[0],queue)) {
      timer.watch(session::remainingMillis,()->expired[0]++);assertEquals(10000,queue.delay);
      now[0]+=9999;timer.refresh();assertTrue(session.valid());assertEquals(1,queue.delay);
      now[0]++;timer.refresh();assertFalse(session.valid());assertEquals(1,expired[0]);
      PasswordAutofillSessions.Session cancelled=new PasswordAutofillSessions.Session(null,()->now[0]);
      timer.watch(cancelled::remainingMillis,()->expired[0]++);cancelled.cancelled=true;timer.refresh();assertEquals(2,expired[0]);
      PasswordAutofillSessions.Session reversed=new PasswordAutofillSessions.Session(null,()->now[0]);now[0]--;
      assertEquals(0,reversed.remainingMillis());
    }
  }); }

  @Test public void remainingPredicateCanReplaceItsOwnWatch() { main(()->{
    long[] remaining={10};Queue queue=new Queue();int[] calls={0};
    try(NativeDeadlineTimer timer=new NativeDeadlineTimer(()->0,queue)) {
      timer.watch(()->{if(remaining[0]==0)timer.after(100,()->calls[0]+=10);return remaining[0];},()->calls[0]++);
      remaining[0]=0;timer.refresh();assertEquals(100,queue.delay);assertEquals(0,calls[0]);
    }
  }); }

  @Test public void realAndroidHandlerDeliversOnMainAndCloseRemovesPendingWork() throws Exception {
    CountDownLatch delivered=new CountDownLatch(1);AtomicInteger calls=new AtomicInteger();NativeDeadlineTimer[] timers=new NativeDeadlineTimer[2];
    main(()->{
      timers[0]=new NativeDeadlineTimer();timers[1]=new NativeDeadlineTimer();
      timers[1].after(20,()->calls.addAndGet(100));timers[1].close();
      timers[0].after(40,()->{calls.incrementAndGet();delivered.countDown();});
    });
    try {assertTrue("Handler did not deliver expiry",delivered.await(10,TimeUnit.SECONDS));main(()->assertEquals(1,calls.get()));}
    finally {main(()->{timers[0].close();timers[1].close();});}
    try{new NativeDeadlineTimer().after(1,()->{});fail("Worker thread accepted");}catch(IllegalStateException expected){}
  }
}
