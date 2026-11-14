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
 * a pipe failure is reported once and stops the capture's events, and an automatic reopen after a
 * call or pause is refused until a user-initiated start.
 */
public final class LiveCaptureControllerTest {
 static final String A="12345678-1234-1234-1234-123456789abc",B="87654321-4321-4321-4321-cba987654321";
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 static void await(CountDownLatch latch)throws Exception{check(latch.await(5,TimeUnit.SECONDS),"timeout");}

 /** Blocks reads until stopped; read returns -1 after requestStop, or immediately when failing. */
 static final class Source implements LiveVoiceCapture.Source {
  final CountDownLatch stopped=new CountDownLatch(1),closed=new CountDownLatch(1),closeEntered=new CountDownLatch(1);final boolean fail;
  volatile CountDownLatch allowClose;volatile boolean failClose;
  Source(boolean fail){this.fail=fail;}
  public int read(short[] buffer,int offset,int length){if(fail)return -1;try{stopped.await(5,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}return -1;}
  public long captureTimeNs(long frame){return VoiceLatencyTrials.UNSET;}
  public String clock(){return "test";}
  public void requestStop(){stopped.countDown();}
  public void close(){stopped.countDown();closeEntered.countDown();try{if(allowClose!=null)check(allowClose.await(5,TimeUnit.SECONDS),"release allowed");}catch(InterruptedException error){throw new IllegalStateException(error);}if(failClose)throw new IllegalStateException("release failed");closed.countDown();}
 }
 static final LiveVoiceCapture.Detector DETECTOR=new LiveVoiceCapture.Detector(){public float[] process(float[] w){return new float[]{0f};}public void reset(){}public void close(){}};

 static final class Host implements LiveCaptureController.Host {
  final AtomicBoolean open=new AtomicBoolean(true),startAllowed=new AtomicBoolean(true);final AtomicBoolean failReads=new AtomicBoolean();
  final List<String> events=new CopyOnWriteArrayList<>();final List<Source> sources=new CopyOnWriteArrayList<>();
  final AtomicReference<Runnable> beforeOpen=new AtomicReference<>(),beforeCapture=new AtomicReference<>();final AtomicInteger captures=new AtomicInteger();
  final AtomicBoolean draftActive=new AtomicBoolean();
  volatile CountDownLatch ended=new CountDownLatch(1);
  public boolean open(long epoch){return open.get();}
  public boolean canStart(long epoch){return open.get()&&startAllowed.get();}
  public void beforeCapture(long epoch,boolean reopen){Runnable hook=beforeCapture.getAndSet(null);if(hook!=null)hook.run();if(!reopen&&draftActive.getAndSet(false))events.add("draft-released");}
  public LiveVoiceCapture capture(String id,LiveVoiceCapture.Sink sink,boolean echoCancel){
   captures.incrementAndGet();
   return new LiveVoiceCapture(null,id,sink,LiveVoiceCapture.DICTATION,()->{Runnable hook=beforeOpen.getAndSet(null);if(hook!=null)hook.run();check(!draftActive.get(),"draft released before live acquisition");events.add("mic:"+id);Source source=new Source(failReads.get());sources.add(source);return source;},()->DETECTOR);
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
  final CountDownLatch done=new CountDownLatch(1);volatile String refused,code;volatile boolean piped;
  public void started(String id,int rate,boolean echo,boolean piped){check(rate==16000,"16 kHz");this.piped=piped;done.countDown();}
  public void refused(String message,String code){refused=message;this.code=code;done.countDown();}
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
   controller.start(controller.reserve(A,1),false,()->transport,"room",false,started);await(started.done);
   check(started.refused==null&&started.piped,"piped capture started");
   check(host.events.indexOf("warm:"+A)>=0&&host.events.indexOf("warm:"+A)<host.events.indexOf("mic:"+A),"agent session warm before microphone");
   Stop stop=new Stop();controller.stop(A,false,System.currentTimeMillis(),stop);await(stop.done);
   check(stop.serverClosed&&host.events.contains("close:"+A),"stop acknowledges server close");
   check(host.sources.get(0).closed.getCount()==0,"microphone released on stop");

   // A Stop during native startup refuses the start and closes the pipe without events.
   host.events.clear();Transport second=new Transport(host.events);Result cancelled=new Result();
   LiveCaptureAdmission.Ticket ticket=controller.reserve(B,1);
   host.beforeOpen.set(()->controller.stop(B,true,System.currentTimeMillis(),new Stop()));
   controller.start(ticket,true,()->second,null,false,cancelled);await(cancelled.done);
   check(cancelled.refused!=null&&cancelled.done.getCount()==0,"stop during startup refuses");
   check(host.events.contains("close:"+B),"cancelled startup closes the warmed pipe");

   // A stale reservation or a closed host gate never opens the microphone.
   host.events.clear();LiveCaptureAdmission.Ticket stale=controller.reserve(A,2);controller.reserve(B,2);check(!controller.current(stale),"replaced reservation stale");
   Result staleResult=new Result();controller.start(stale,false,null,null,false,staleResult);await(staleResult.done);
   check(LiveCaptureController.CANCELLED.equals(staleResult.refused)&&!host.events.contains("mic:"+A),"stale reservation refused");
   host.open.set(false);Result gated=new Result();controller.start(controller.reserve(A,3),false,null,null,false,gated);await(gated.done);
   check(LiveCaptureController.CANCELLED.equals(gated.refused)&&host.events.isEmpty(),"closed host gate refused");host.open.set(true);

   // An unavailable owner route refuses before the microphone opens.
   Result unrouted=new Result();controller.start(controller.reserve(A,4),false,()->{throw new SecurityException("no owner");},null,false,unrouted);await(unrouted.done);
   check(unrouted.refused!=null&&!host.events.contains("mic:"+A),"no owner route, no microphone");

   // A Stop while the agent session warms is a cancellation, never an enrollment failure.
   host.events.clear();CountDownLatch warming=new CountDownLatch(1),cancelledInFlight=new CountDownLatch(1);
   Result warmStopped=new Result();AtomicBoolean firstCancel=new AtomicBoolean();
   LiveSegmentPipe.Transport slow=new LiveSegmentPipe.Transport(){
    public void check(){}
    public JSONObject post(JSONObject body)throws Exception{if(body.optBoolean("close"))return new JSONObject().put("status",200).put("body","{\"closed\":true}");warming.countDown();LiveCaptureControllerTest.check(cancelledInFlight.await(5,TimeUnit.SECONDS),"warm cancelled");throw new java.io.IOException("cancelled");}
    public void cancelInFlight(){
     boolean waitForResult=firstCancel.compareAndSet(false,true);
     cancelledInFlight.countDown();
     // Let the startup worker classify the result before the stopping caller continues. The
     // drain thread can cancel again while settling ready(), so only the first caller waits.
     if(waitForResult)try{await(warmStopped.done);}catch(Exception e){throw new AssertionError(e);}
    }
   };
   controller.start(controller.reserve(B,4),false,()->slow,null,false,warmStopped);
   await(warming);controller.stop(B,false,System.currentTimeMillis(),new Stop());await(warmStopped.done);
   check(LiveCaptureController.CANCELLED.equals(warmStopped.refused)&&!host.events.contains("mic:"+B),"stop during warm-up is a cancellation");

   // A call that starts while the agent session warms refuses the start with the call-active code
   // and stops waiting for the agent; the microphone never opens.
   host.events.clear();CountDownLatch callWarming=new CountDownLatch(1),callCancelled=new CountDownLatch(1);
   LiveSegmentPipe.Transport callWarm=new LiveSegmentPipe.Transport(){
    public void check(){}
    public JSONObject post(JSONObject body)throws Exception{if(body.optBoolean("close"))return new JSONObject().put("status",200).put("body","{\"closed\":true}");callWarming.countDown();LiveCaptureControllerTest.check(callCancelled.await(5,TimeUnit.SECONDS),"warm cancelled by the call");throw new java.io.IOException("cancelled");}
    public void cancelInFlight(){callCancelled.countDown();}
   };
   Result duringCall=new Result();controller.start(controller.reserve(A,4),false,()->callWarm,null,false,duringCall);
   await(callWarming);controller.interrupt(SpeechAudioFocusPolicy.CALL_ACTIVE);await(duringCall.done);
   check(LiveCaptureController.INTERRUPTED.equals(duringCall.refused)&&SpeechAudioFocusPolicy.CALL_ACTIVE.equals(duringCall.code),"call during warm-up refused as call-active: "+duringCall.refused);
   check(!host.events.contains("mic:"+A),"no microphone after a call during warm-up");
   // A call during native startup (after the warm-up) is refused the same way.
   host.events.clear();Transport callStartup=new Transport(host.events);Result duringStartup=new Result();
   host.beforeOpen.set(()->controller.interrupt(SpeechAudioFocusPolicy.CALL_ACTIVE));
   controller.start(controller.reserve(B,4),false,()->callStartup,null,false,duringStartup);await(duringStartup.done);
   check(SpeechAudioFocusPolicy.CALL_ACTIVE.equals(duringStartup.code),"call during native startup refused as call-active: "+duringStartup.refused);
   check(host.events.stream().noneMatch(e->e.startsWith("ended:")),"refused start reports no end");

   // An agent that fails the warm-up refuses the start with the transport failure, not a
   // cancellation, and no transcript event goes out for a capture that never started.
   host.events.clear();
   LiveSegmentPipe.Transport down=new LiveSegmentPipe.Transport(){
    public void check(){}
    public JSONObject post(JSONObject body)throws Exception{return new JSONObject().put("status",body.optBoolean("close")?200:503).put("body","{}");}
   };
   Result warmFailed=new Result();controller.start(controller.reserve(A,4),false,()->down,null,false,warmFailed);await(warmFailed.done);
   check(LiveCaptureController.SESSION_UNAVAILABLE.equals(warmFailed.refused)&&"TRANSPORT".equals(warmFailed.code),"warm failure names the transport: "+warmFailed.refused+"/"+warmFailed.code);
   check(host.events.stream().noneMatch(e->e.startsWith("transcript:")||e.startsWith("mic:")),"no transcript or microphone for a failed warm-up");

   // A call while the prompt is open refuses the grant with the call-active code.
   LiveCaptureAdmission.Ticket callPrompt=controller.reserve(A,9);controller.interrupt(SpeechAudioFocusPolicy.CALL_ACTIVE);
   Result promptCall=new Result();controller.refuse(callPrompt,promptCall);
   check(LiveCaptureController.INTERRUPTED.equals(promptCall.refused)&&SpeechAudioFocusPolicy.CALL_ACTIVE.equals(promptCall.code),"call during the prompt refused as call-active: "+promptCall.refused);
   // A pause while the reservation waits on its permission prompt keeps it; the grant then starts.
   host.events.clear();LiveCaptureAdmission.Ticket prompted=controller.reserve(B,8);
   controller.pause(List.of(prompted));check(controller.current(prompted),"reservation survives the prompt's pause");
   Result granted=new Result();controller.start(prompted,false,null,null,false,granted);await(granted.done);
   check(granted.refused==null&&host.events.contains("mic:"+B),"capture starts after the grant: "+granted.refused);
   // A pause during a running capture stops it and reports it ended once, as paused.
   host.ended=new CountDownLatch(1);controller.pause(List.of(prompted));
   for(int i=0;i<100&&host.sources.get(host.sources.size()-1).closed.getCount()>0;i++)Thread.sleep(20);
   check(host.sources.get(host.sources.size()-1).closed.getCount()==0,"pause stops the running microphone");
   check(host.events.stream().filter(e->e.startsWith("ended:")).toList().equals(List.of("ended:"+B+":"+LiveCaptureController.PAUSED)),"paused end reported once: "+host.events);

   // Interruption ends the running capture with its reason; cancelAll closes its pipe.
   host.events.clear();host.ended=new CountDownLatch(1);Transport third=new Transport(host.events);Result running=new Result();
   controller.start(controller.reserve(A,5),true,()->third,null,false,running);await(running.done);check(running.refused==null,"second capture");
   controller.interrupt(SpeechAudioFocusPolicy.CALL_ACTIVE);await(host.ended);
   check(host.events.contains("ended:"+A+":"+SpeechAudioFocusPolicy.CALL_ACTIVE),"interruption reason reported");
   controller.cancelAll();
   for(int i=0;i<100&&!host.events.contains("close:"+A);i++)Thread.sleep(20);
   check(host.events.contains("close:"+A),"cancelAll closes the pipe");
   check(!host.events.contains("ended:"+A+":"+LiveCaptureController.PAUSED),"an ended capture is not reported again on pause");

   // A microphone failure is reported once and discards the pipe.
   host.events.clear();host.ended=new CountDownLatch(1);host.failReads.set(true);Transport fourth=new Transport(host.events);Result failing=new Result();
   controller.start(controller.reserve(B,6),false,()->fourth,null,false,failing);await(failing.done);await(host.ended);
   check(host.events.contains("ended:"+B+":capture"),"microphone failure reported");
   for(int i=0;i<100&&!host.events.contains("close:"+B);i++)Thread.sleep(20);
   check(host.events.contains("close:"+B),"failed capture closes the pipe");

   // Back-to-back piped captures: the next start may run while the previous drain thread is still
   // returning to the pool after completing its close. It must never be refused as busy.
   host.failReads.set(false);
   for(int i=0;i<300;i++){
    String id=i%2==0?A:B;Transport each=new Transport(new CopyOnWriteArrayList<>());Result next=new Result();
    controller.start(controller.reserve(id,100+i),false,()->each,null,false,next);await(next.done);
    check(next.refused==null&&next.piped,"back-to-back capture "+i+" refused: "+next.refused);
    Stop done=new Stop();controller.stop(id,false,System.currentTimeMillis(),done);await(done.done);
    check(done.serverClosed,"back-to-back capture "+i+" closed");
   }

   // An automatic reopen after a call or pause since the last capture is refused without opening a
   // capture, also when the call or pause began and ended while no capture was running.
   int opened=host.captures.get();
   controller.interrupt(SpeechAudioFocusPolicy.CALL_ACTIVE);
   Result afterCall=new Result();controller.start(controller.reserve(A,200),false,null,null,true,afterCall);await(afterCall.done);
   check(SpeechAudioFocusPolicy.CALL_ACTIVE.equals(afterCall.code)&&host.captures.get()==opened,"reopen after a call refused: "+afterCall.refused);
   controller.cancelAll();
   Result afterPause=new Result();controller.start(controller.reserve(A,201),false,null,null,true,afterPause);await(afterPause.done);
   check(LiveCaptureController.CANCELLED.equals(afterPause.refused)&&afterPause.code==null&&host.captures.get()==opened,"reopen after a pause refused: "+afterPause.refused);
   // A user-initiated start runs and clears it, so the next reopen starts.
   Result user=new Result();controller.start(controller.reserve(A,202),false,null,null,false,user);await(user.done);
   check(user.refused==null&&host.captures.get()==opened+1,"user start after a pause");
   Stop userStop=new Stop();controller.stop(A,false,System.currentTimeMillis(),userStop);await(userStop.done);
   Result reopened=new Result();controller.start(controller.reserve(B,203),false,null,null,true,reopened);await(reopened.done);
   check(reopened.refused==null&&host.captures.get()==opened+2,"reopen with no call or pause since the last capture starts");
   Stop reopenedStop=new Stop();controller.stop(B,false,System.currentTimeMillis(),reopenedStop);await(reopenedStop.done);
   controller.interrupt(SpeechAudioFocusPolicy.CALL_ACTIVE);
   Result called=new Result();controller.start(controller.reserve(A,204),false,null,null,false,called);await(called.done);
   check(called.refused==null,"user start after a call");
   Stop calledStop=new Stop();controller.stop(A,false,System.currentTimeMillis(),calledStop);await(calledStop.done);
   Result again=new Result();controller.start(controller.reserve(B,205),false,null,null,true,again);await(again.done);
   check(again.refused==null&&host.captures.get()==opened+4,"reopen after the user start");
   Stop againStop=new Stop();controller.stop(B,false,System.currentTimeMillis(),againStop);await(againStop.done);
   // Phone focus blocks a new start before the admitted capture receives its terminal callback.
   host.events.clear();host.ended=new CountDownLatch(1);Result admitted=new Result();
   controller.start(controller.reserve(A,899),false,null,null,false,admitted);await(admitted.done);
   check(admitted.refused==null,"capture admitted before phone focus closes startup");
   host.startAllowed.set(false);controller.interrupt(SpeechAudioFocusPolicy.CALL_ACTIVE);await(host.ended);
   check(host.events.stream().filter(e->e.equals("ended:"+A+":"+SpeechAudioFocusPolicy.CALL_ACTIVE)).count()==1,"admitted capture reports the call interruption exactly once");
   check(host.sources.get(host.sources.size()-1).closed.getCount()==0,"interrupted capture releases the microphone");
   // Protected surfaces can close startup without closing delivery for an older interrupted capture.
   int beforeDenied=host.captures.get();host.startAllowed.set(false);Result protectedStart=new Result();
   controller.start(controller.reserve(A,900),false,null,null,false,protectedStart);await(protectedStart.done);
   check(LiveCaptureController.CANCELLED.equals(protectedStart.refused)&&host.captures.get()==beforeDenied,"protected surface refuses before capture");
   host.startAllowed.set(true);host.events.clear();host.beforeOpen.set(()->host.startAllowed.set(false));Result lateProtection=new Result();
   controller.start(controller.reserve(A,901),false,null,null,false,lateProtection);await(lateProtection.done);
   check(LiveCaptureController.CANCELLED.equals(lateProtection.refused),"protection during native start is cancellation, not capture failure");
   check(host.sources.get(host.sources.size()-1).closed.getCount()==0,"late protected startup closes microphone");
   check(host.events.stream().noneMatch(e->e.startsWith("ended:")),"unreported protected startup emits no capture end");
   host.startAllowed.set(true);
  }finally{controller.shutdown();}
  AtomicInteger refusedAfterShutdown=new AtomicInteger();
  controller.start(controller.reserve(A,7),false,null,null,false,new LiveCaptureController.Started(){public void started(String id,int r,boolean e,boolean p){}public void refused(String m,String c){refusedAfterShutdown.incrementAndGet();}});
  check(refusedAfterShutdown.get()==1,"shut-down controller refuses on the caller");
  microphoneHandoff();
  System.out.println("PASS live capture controller: warm-before-mic, startup cancellation, stale gates, owner route, interruption, failure, reopen fence");
 }
 /** Real controller and capture threads, with only the physical microphone replaced. */
 static void microphoneHandoff()throws Exception{
  Host host=new Host();LiveCaptureController controller=new LiveCaptureController(host);
  try{
   Result running=new Result();controller.start(controller.reserve(A,1),false,null,null,false,running);await(running.done);
   Source original=host.sources.get(0);original.allowClose=new CountDownLatch(1);
   CountDownLatch draftStarted=new CountDownLatch(1);AtomicInteger refusals=new AtomicInteger();
   long before=System.nanoTime();
   controller.interruptAndDrain("capture-replaced",()->{check(original.closed.getCount()==0,"source release precedes draft start");host.draftActive.set(true);draftStarted.countDown();},refusals::incrementAndGet);
   check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-before)<500,"replacement fences without blocking the caller");
   await(original.closeEntered);
   // Exceed the old bounded stop. Its 1500ms join was not a release acknowledgement.
   check(!draftStarted.await(1700,TimeUnit.MILLISECONDS),"draft waits beyond bounded stop for source release");
   original.allowClose.countDown();await(draftStarted);
   check(host.events.stream().filter(e->e.equals("ended:"+A+":capture-replaced")).count()==1,"handoff reports the replacement reason exactly once");
   check(refusals.get()==0&&host.draftActive.get(),"draft admitted after release");
   int opened=host.captures.get();Result auto=new Result();
   controller.start(controller.reserve(B,2),false,null,null,true,auto);await(auto.done);
   check("capture-replaced".equals(auto.code)&&host.captures.get()==opened&&host.draftActive.get(),"automatic reopen cannot consume a draft");
   Result user=new Result();controller.start(controller.reserve(B,3),false,null,null,false,user);await(user.done);
   check(user.refused==null&&!host.draftActive.get(),"explicit live start finalizes draft on the serial worker");
   check(host.events.indexOf("draft-released")<host.events.lastIndexOf("mic:"+B),"draft release precedes live acquisition");
   Stop stopped=new Stop();controller.stop(B,true,System.currentTimeMillis(),stopped);await(stopped.done);

   // A stale queued user start cannot clear the draft's automatic-reopen fence.
   CountDownLatch workerEntered=new CountDownLatch(1),allowWorker=new CountDownLatch(1);
   controller.onWorker(()->{workerEntered.countDown();try{await(allowWorker);}catch(Exception error){throw new AssertionError(error);}},()->{});await(workerEntered);
   Result stale=new Result();controller.start(controller.reserve(A,4),false,null,null,false,stale);
   CountDownLatch nextDraft=new CountDownLatch(1);
   controller.interruptAndDrain("capture-replaced",()->{host.draftActive.set(true);nextDraft.countDown();},refusals::incrementAndGet);
   allowWorker.countDown();await(stale.done);await(nextDraft);
   Result afterStale=new Result();controller.start(controller.reserve(B,5),false,null,null,true,afterStale);await(afterStale.done);
   check("capture-replaced".equals(afterStale.code)&&host.captures.get()==opened+1,"stale user start preserves draft fence");
   // The host gate can change while it finalizes another microphone mode.
   host.beforeCapture.set(()->host.startAllowed.set(false));Result protectedStart=new Result();
   controller.start(controller.reserve(A,6),false,null,null,false,protectedStart);await(protectedStart.done);
   check(protectedStart.refused!=null&&host.captures.get()==opened+1,"recheck admission after host cleanup");
  }finally{controller.shutdown();}

  Host pending=new Host();LiveCaptureController startup=new LiveCaptureController(pending);
  try{
   CountDownLatch opening=new CountDownLatch(1),allowOpen=new CountDownLatch(1),draft=new CountDownLatch(1);
   pending.beforeOpen.set(()->{opening.countDown();try{await(allowOpen);}catch(Exception error){throw new AssertionError(error);}});
   Result result=new Result();startup.start(startup.reserve(A,1),false,null,null,false,result);await(opening);
   startup.interruptAndDrain("capture-replaced",()->{check(pending.sources.size()==1&&pending.sources.get(0).closed.getCount()==0,"late source released before draft start");draft.countDown();},()->{throw new AssertionError("pending start drain refused");});
   check(draft.getCount()==1,"pending native open must finish before handoff");allowOpen.countDown();await(result.done);await(draft);
   check("capture-replaced".equals(result.code),"pending startup refuses with original replacement reason");
  }finally{startup.shutdown();}

  Host broken=new Host();LiveCaptureController failed=new LiveCaptureController(broken);
  try{
   Result running=new Result();failed.start(failed.reserve(A,1),false,null,null,false,running);await(running.done);
   Source source=broken.sources.get(0);source.failClose=true;CountDownLatch refused=new CountDownLatch(1);AtomicInteger drafts=new AtomicInteger();
   failed.interruptAndDrain("capture-replaced",drafts::incrementAndGet,refused::countDown);await(refused);
   check(drafts.get()==0&&source.closed.getCount()==1,"failed source release refuses draft acquisition");
   Result replacement=new Result();failed.start(failed.reserve(B,2),false,null,null,false,replacement);await(replacement.done);
   check(LiveCaptureController.CAPTURE.equals(replacement.code)&&broken.captures.get()==1,"unconfirmed owner fences later live starts");
  }finally{failed.shutdown();}
 }

}
