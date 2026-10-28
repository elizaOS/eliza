package ai.eliza.voice;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
public final class LiveCaptureAdmissionTest {
 static void check(boolean condition,String why){if(!condition)throw new AssertionError(why);}
 static void await(CountDownLatch latch)throws Exception{check(latch.await(2,TimeUnit.SECONDS),"timeout");}
 public static void main(String[] args)throws Exception{
  LiveCaptureAdmission gate=new LiveCaptureAdmission();
  LiveCaptureAdmission.Ticket permission=gate.begin("permission",1);gate.stop("permission");
  check(!gate.current(permission),"permission callback must not restart a stopped capture");
  AtomicInteger stopped=new AtomicInteger();
  check(!gate.attach(permission,stopped::incrementAndGet),"cancelled permission cannot attach");
  LiveCaptureAdmission.Ticket start=gate.begin("blocked-start",1);
  CountDownLatch opening=new CountDownLatch(1),finishOpen=new CountDownLatch(1),done=new CountDownLatch(1);
  AtomicBoolean cancelled=new AtomicBoolean(),published=new AtomicBoolean();AtomicReference<Throwable> failure=new AtomicReference<>();
  Thread worker=new Thread(()->{try{
   check(gate.attach(start,()->cancelled.set(true)),"publish cancellation before start");
   opening.countDown();await(finishOpen); // Simulates an uncancellable native constructor on the serialized worker.
   if(gate.current(start))published.set(true);
  }catch(Throwable error){failure.set(error);}finally{done.countDown();}});
  worker.start();await(opening);gate.cancelAll();
  check(cancelled.get(),"pause must cancel while worker is blocked in start");
  check(!gate.events(start),"lifecycle cancellation fences events immediately");
  finishOpen.countDown();await(done);worker.join();check(failure.get()==null,"worker failed: "+failure.get());
  check(!published.get(),"late start must not publish");
  LiveCaptureAdmission.Ticket tail=gate.begin("tail",2);gate.stop("tail");
  check(!gate.current(tail)&&gate.events(tail),"explicit Stop preserves buffered tail/end for cutoff reconciliation");
  LiveCaptureAdmission.Ticket next=gate.begin("next",2);gate.stop("tail");
  check(gate.current(next)&&!gate.events(tail),"old stop cannot cancel a replacement or leak its events");
  check(stopped.get()==1,"late cancellation called once");
  System.out.println("PASS live capture admission: permission stop, blocked start, pause, tail, stale stop");
 }
}
