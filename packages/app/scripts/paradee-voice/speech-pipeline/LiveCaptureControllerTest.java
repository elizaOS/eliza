package ai.eliza.voice;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Host-JVM ordering checks for the live capture controller with a fake source, detector and agent
 * transport (no AudioRecord, VAD model or agent): the agent session is warm before the microphone
 * opens, cancellation during startup and stale host gates refuse, replacement and cancelAll close
 * the earlier pipe, Stop reports the acknowledged server close, interruption reports its reason,
 * and a pipe failure is reported once and stops the capture's events.
 */
public final class LiveCaptureControllerTest {
 static final String A="12345678-1234-1234-1234-123456789abc",B="87654321-4321-4321-4321-cba987654321";
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 static void await(CountDownLatch latch)throws Exception{check(latch.await(5,TimeUnit.SECONDS),"timeout");}

 /** Blocks reads until stopped; read returns -1 after requestStop, or immediately when failing. */
 static final class Source implements LiveVoiceCapture.Source {
  final CountDownLatch stopped=new CountDownLatch(1),closed=new CountDownLatch(1);final boolean fail;
  Source(boolean fail){this.fail=fail;}
  public int read(short[] buffer,int offset,int length){if(fail)return -1;try{stopped.await(5,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}return -1;}
  public long captureTimeNs(long frame){return VoiceLatencyTrials.UNSET;}
  public String clock(){return "test";}
  public void requestStop(){stopped.countDown();}
  public void close(){stopped.countDown();closed.countDown();}
 }
 static final LiveVoiceCapture.Detector DETECTOR=new LiveVoiceCapture.Detector(){public float[] process(float[] w){return new float[]{0f};}public void reset(){}public void close(){}};

 static final class Host implements LiveCaptureController.Host {
  final AtomicBoolean open=new AtomicBoolean(true);final AtomicBoolean failReads=new AtomicBoolean();
  final List<String> events=new CopyOnWriteArrayList<>();final List<Source> sources=new CopyOnWriteArrayList<>();
  final AtomicReference<Runnable> beforeOpen=new AtomicReference<>();
  volatile CountDownLatch ended=new CountDownLatch(1);
  public boolean open(long epoch){return open.get();}
  public LiveVoiceCapture capture(String id,LiveVoiceCapture.Sink sink,boolean echoCancel){
   return new LiveVoiceCapture(null,id,sink,LiveVoiceCapture.DICTATION,()->{Runnable hook=beforeOpen.getAndSet(null);if(hook!=null)hook.run();events.add("mic:"+id);Source source=new Source(failReads.get());sources.add(source);return source;},()->DETECTOR);
  }
  public void frames(String id,JSONArray frames,JSONArray vad,float peak){events.add("frames:"+id);}
  public void ended(String id,String error){events.add("ended:"+id+":"+error);ended.countDown();}
  public void transcript(String id,JSONObject value,String error){events.add("transcript:"+id+":"+(error!=null?error:value.optString("text")));}
 }
 static final class Transport implements LiveSegmentPipe.Transport {
  final List<JSONObject> bodies=new CopyOnWriteArrayList<>();final List<String> events;volatile boolean current=true,failData;
  Transport(List<String> events){this.events=events;}
  public void check(){if(!current)throw new SecurityException("changed");}
  public JSONObject post(JSONObject body)throws Exception{
   check();bodies.add(body);
   if(body.optBoolean("close")){events.add("close:"+body.getString("sessionId"));return new JSONObject().put("status",200).put("body",new JSONObject().put("closed",true).toString());}
   if(failData&&body.getJSONArray("frames").length()>0)return new JSONObject().put("status",502).put("body",new JSONObject().put("code","ASR_FAILED").toString());
   events.add("warm:"+body.getString("sessionId"));return new JSONObject().put("status",200).put("body","{}");
  }
 }
 static final class Result implements LiveCaptureController.Started {
  final CountDownLatch done=new CountDownLatch(1);volatile String refused;volatile boolean piped;
  public void started(String id,int rate,boolean echo,boolean piped){check(rate==16000,"16 kHz");this.piped=piped;done.countDown();}
  public void refused(String message,String code){refused=message;done.countDown();}
 }
 static final class Stop implements LiveCaptureController.Stopped {
  final CountDownLatch done=new CountDownLatch(1);volatile boolean serverClosed;
  public void stopped(String id,long duration,boolean serverClosed){this.serverClosed=serverClosed;done.countDown();}
 }

 public static void main(String[] args)throws Exception{
  Host host=new Host();LiveCaptureController controller=new LiveCaptureController(host);
  try{
   // Warm before microphone; explicit Stop acknowledges the server close.
   Transport transport=new Transport(host.events);Result started=new Result();
   controller.start(controller.reserve(A,1),false,()->transport,"room",started);await(started.done);
   check(started.refused==null&&started.piped,"piped capture started");
   check(host.events.indexOf("warm:"+A)>=0&&host.events.indexOf("warm:"+A)<host.events.indexOf("mic:"+A),"agent session warm before microphone");
   Stop stop=new Stop();controller.stop(A,false,System.currentTimeMillis(),stop);await(stop.done);
   check(stop.serverClosed&&host.events.contains("close:"+A),"stop acknowledges server close");
   check(host.sources.get(0).closed.getCount()==0,"microphone released on stop");

   // A Stop during native startup refuses the start and closes the pipe without events.
   host.events.clear();Transport second=new Transport(host.events);Result cancelled=new Result();
   LiveCaptureAdmission.Ticket ticket=controller.reserve(B,1);
   host.beforeOpen.set(()->controller.stop(B,true,System.currentTimeMillis(),new Stop()));
   controller.start(ticket,true,()->second,null,cancelled);await(cancelled.done);
   check(cancelled.refused!=null&&cancelled.done.getCount()==0,"stop during startup refuses");
   check(host.events.contains("close:"+B),"cancelled startup closes the warmed pipe");

   // A stale reservation or a closed host gate never opens the microphone.
   host.events.clear();LiveCaptureAdmission.Ticket stale=controller.reserve(A,2);controller.reserve(B,2);check(!controller.current(stale),"replaced reservation stale");
   Result staleResult=new Result();controller.start(stale,false,null,null,staleResult);await(staleResult.done);
   check(LiveCaptureController.CANCELLED.equals(staleResult.refused)&&!host.events.contains("mic:"+A),"stale reservation refused");
   host.open.set(false);Result gated=new Result();controller.start(controller.reserve(A,3),false,null,null,gated);await(gated.done);
   check(LiveCaptureController.CANCELLED.equals(gated.refused)&&host.events.isEmpty(),"closed host gate refused");host.open.set(true);

   // An unavailable owner route refuses before the microphone opens.
   Result unrouted=new Result();controller.start(controller.reserve(A,4),false,()->{throw new SecurityException("no owner");},null,unrouted);await(unrouted.done);
   check(unrouted.refused!=null&&!host.events.contains("mic:"+A),"no owner route, no microphone");

   // Interruption ends the running capture with its reason; cancelAll closes its pipe.
   host.events.clear();host.ended=new CountDownLatch(1);Transport third=new Transport(host.events);Result running=new Result();
   controller.start(controller.reserve(A,5),true,()->third,null,running);await(running.done);check(running.refused==null,"second capture");
   controller.interrupt(SpeechAudioFocusPolicy.CALL_ACTIVE);await(host.ended);
   check(host.events.contains("ended:"+A+":"+SpeechAudioFocusPolicy.CALL_ACTIVE),"interruption reason reported");
   controller.cancelAll();
   for(int i=0;i<100&&!host.events.contains("close:"+A);i++)Thread.sleep(20);
   check(host.events.contains("close:"+A),"cancelAll closes the pipe");

   // A microphone failure is reported once and discards the pipe.
   host.events.clear();host.ended=new CountDownLatch(1);host.failReads.set(true);Transport fourth=new Transport(host.events);Result failing=new Result();
   controller.start(controller.reserve(B,6),false,()->fourth,null,failing);await(failing.done);await(host.ended);
   check(host.events.contains("ended:"+B+":capture"),"microphone failure reported");
   for(int i=0;i<100&&!host.events.contains("close:"+B);i++)Thread.sleep(20);
   check(host.events.contains("close:"+B),"failed capture closes the pipe");
  }finally{controller.shutdown();}
  AtomicInteger refusedAfterShutdown=new AtomicInteger();
  controller.start(controller.reserve(A,7),false,null,null,new LiveCaptureController.Started(){public void started(String id,int r,boolean e,boolean p){}public void refused(String m,String c){refusedAfterShutdown.incrementAndGet();}});
  check(refusedAfterShutdown.get()==1,"shut-down controller refuses on the caller");
  System.out.println("PASS live capture controller: warm-before-mic, startup cancellation, stale gates, owner route, interruption, failure");
 }
}
