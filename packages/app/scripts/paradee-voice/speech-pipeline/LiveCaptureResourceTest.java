package ai.eliza.voice;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class LiveCaptureResourceTest {
 static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
 static void await(CountDownLatch latch)throws Exception{check(latch.await(2,TimeUnit.SECONDS),"timed out");}
 public static void main(String[] args)throws Exception{
  LiveCaptureResource owner=new LiveCaptureResource();
  CountDownLatch reading=new CountDownLatch(1),unblocked=new CountDownLatch(1);
  AtomicReference<Throwable> failure=new AtomicReference<>();
  AtomicReference<Thread> releasedBy=new AtomicReference<>();
  LiveCaptureResource.Source source=new LiveCaptureResource.Source(){
   boolean released;
   public void requestStop(){check(!released,"stop after release");unblocked.countDown();}
   public void close(){check(!released,"double release");released=true;releasedBy.set(Thread.currentThread());}
  };
  check(owner.attach(source),"attach");
  Thread worker=new Thread(()->{reading.countDown();try{await(unblocked);}catch(Throwable error){failure.set(error);}finally{try{owner.release(source);}catch(Throwable error){failure.set(error);}}});
  worker.start();await(reading);owner.requestStop();owner.requestStop();worker.join(2000);
  check(failure.get()==null,"worker failed: "+failure.get());
  check(!worker.isAlive(),"stop must unblock the read before join");
  check(releasedBy.get()==worker,"release must remain on worker");owner.requestStop();
  LiveCaptureResource late=new LiveCaptureResource();late.requestStop();
  check(!late.attach(source),"source opening after stop must never be admitted");
  for(int i=0;i<100;i++){
   LiveCaptureResource race=new LiveCaptureResource();AtomicReference<Throwable> error=new AtomicReference<>();
   LiveCaptureResource.Source racing=new LiveCaptureResource.Source(){boolean closed;public void requestStop(){check(!closed,"stop raced past release");}public void close(){closed=true;}};
   check(race.attach(racing),"race attach");
   Thread stopper=new Thread(()->{try{race.requestStop();}catch(Throwable t){error.set(t);}});
   Thread releaser=new Thread(()->{try{race.release(racing);}catch(Throwable t){error.set(t);}});stopper.start();releaser.start();stopper.join();releaser.join();
   check(error.get()==null,"concurrent stop/release violated ownership");race.requestStop();
  }
  System.out.println("PASS live capture resource: blocked read, late open, worker release, 100 stop/release races");
 }
}
