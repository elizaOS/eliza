package ai.eliza.voice;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
public final class SpeechRequestGateTest {
 static void check(boolean condition,String why){if(!condition)throw new AssertionError(why);}
 public static void main(String[] args){
  SpeechRequestGate gate=new SpeechRequestGate();
  SpeechRequestGate.Admission first=gate.admit("a",true);
  check(first.request!=null&&first.refusal==null&&gate.get("a")==first.request,"idle gate admits one request");
  check(gate.admit("b",true).refusal==SpeechRequestGate.Refusal.UNAVAILABLE,"a second request is refused while one runs");
  check(gate.admit("b",false).refusal==SpeechRequestGate.Refusal.BUSY,"replace=false reports the busy speaker");
  check(gate.admit("a",true).request==null,"the same id is not admitted twice");
  AtomicInteger nativeCancels=new AtomicInteger();
  first.request.cancelNative=()->{nativeCancels.incrementAndGet();throw new IllegalStateException("native cancel failed");};
  first.request.cancel();
  check(first.request.cancelled&&nativeCancels.get()==1,"cancel runs the native hook and stays fenced when it throws");
  gate.settle(first.request);
  check(gate.idle()&&gate.get("a")==null,"settling releases admission");
  SpeechRequestGate.Request running=gate.admit("c",true).request;
  // Drain: cancel everything, refuse admission until the worker barrier completes, even after a timeout.
  Object waiterOne=new Object(),waiterTwo=new Object();Runnable timeoutOne=()->{},timeoutTwo=()->{};
  check(gate.beginDrain(waiterOne,timeoutOne)==SpeechRequestGate.Drain.OPENED,"first cancellation opens the drain");
  check(running.cancelled,"the drain cancels the running request");
  check(gate.beginDrain(waiterTwo,timeoutTwo)==SpeechRequestGate.Drain.JOINED,"a second cancellation joins it");
  gate.settle(running);
  check(gate.draining()&&gate.admit("d",true).refusal==SpeechRequestGate.Refusal.UNAVAILABLE,"no admission while draining, even when idle");
  check(gate.leaveDrain(waiterOne)&&!gate.leaveDrain(waiterOne),"a timed-out waiter leaves exactly once");
  Map<Object,Runnable> failed=gate.finishDrain(false);
  check(failed.size()==1&&failed.get(waiterTwo)==timeoutTwo,"an incomplete barrier releases the remaining waiter with its timeout");
  check(gate.draining(),"an incomplete barrier keeps admission closed");
  check(gate.beginDrain(waiterOne,timeoutOne)==SpeechRequestGate.Drain.JOINED,"a later cancellation waits on the still-open drain");
  Map<Object,Runnable> done=gate.finishDrain(true);
  check(done.size()==1&&!gate.draining(),"the completed barrier reopens admission");
  SpeechRequestGate.Request last=gate.admit("e",true).request;
  check(last!=null,"admission resumes after the drain");
  gate.destroy();
  check(last.cancelled&&gate.destroyed(),"destroy cancels what runs");
  gate.settle(last);
  check(gate.admit("f",true).refusal==SpeechRequestGate.Refusal.UNAVAILABLE,"destroyed gate refuses");
  check(gate.beginDrain(new Object(),()->{})==SpeechRequestGate.Drain.UNAVAILABLE,"destroyed gate opens no drain");
  System.out.println("PASS speech request gate: single admission, busy refusal, cancellation, drain barrier, destroy");
 }
}
