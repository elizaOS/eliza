package ai.eliza.voice;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public final class LiveSegmentPipeTest {
 static final String ID="12345678-1234-1234-1234-123456789abc";
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 static void await(CountDownLatch latch)throws Exception{check(latch.await(3,TimeUnit.SECONDS),"timeout");}
 static JSONArray frames(double at)throws Exception{return new JSONArray().put(new JSONObject().put("pcm16","AAAA").put("sampleRate",16000).put("channels",1).put("samples",2).put("timestamp",at));}
 static JSONObject response(JSONObject body)throws Exception{return new JSONObject().put("status",200).put("body",body.toString());}
 static class Sink implements LiveSegmentPipe.Sink {final List<String> errors=new CopyOnWriteArrayList<>();final List<JSONObject> finals=new CopyOnWriteArrayList<>();public void failed(String code){errors.add(code);}public void result(JSONObject value){finals.add(value);}}
 static class Transport implements LiveSegmentPipe.Transport {
  final List<JSONObject> bodies=new CopyOnWriteArrayList<>();volatile boolean current=true;
  public void check(){if(!current)throw new SecurityException("changed enrollment");}
  public JSONObject post(JSONObject body)throws Exception{check();bodies.add(body);return response(body.optBoolean("close")?new JSONObject().put("closed",true):new JSONObject());}
 }
 public static void main(String[] args)throws Exception{
  ExecutorService worker=Executors.newSingleThreadExecutor();
  try{
   Transport transport=new Transport();Sink sink=new Sink();LiveSegmentPipe pipe=new LiveSegmentPipe(transport,sink,ID,"room");
   check(pipe.offer(frames(10),new JSONArray()),"offer");pipe.cutoff(15);check(pipe.offer(frames(20),new JSONArray()),"second offer");pipe.start(worker);check(pipe.ready().get(3,TimeUnit.SECONDS),"ASR ready before microphone");
   check(pipe.close(false,15).get(3,TimeUnit.SECONDS),"server close acknowledged");
   check(transport.bodies.size()==3,"cutoff omits queued later audio but sends close");
   check(transport.bodies.get(1).getJSONArray("frames").getJSONObject(0).getDouble("timestamp")==10,"original sample kept");
   check(transport.bodies.get(0).getString("sessionId").equals(ID),"bound session");
   check(transport.bodies.get(2).getBoolean("close"),"explicit close");

   CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);Transport blocked=new Transport(){public JSONObject post(JSONObject body)throws Exception{if(!body.optBoolean("close")){entered.countDown();await(release);super.post(body);return response(new JSONObject().put("final",new JSONObject().put("turnId","cancelled").put("text","must be dropped")));}return super.post(body);}};
   Sink cancelled=new Sink();LiveSegmentPipe cancellation=new LiveSegmentPipe(blocked,cancelled,ID,null);cancellation.start(worker);cancellation.offer(frames(1),new JSONArray());await(entered);
   cancellation.offer(frames(2),new JSONArray());CompletableFuture<Boolean> end=cancellation.close(true,3);release.countDown();check(end.get(3,TimeUnit.SECONDS),"cancel closes server");
   check(blocked.bodies.size()==2&&blocked.bodies.get(1).optBoolean("close"),"cancel discards queued PCM");check(cancelled.finals.isEmpty(),"no cancelled final");

   Sink lastFailed=new Sink();Transport failedTail=new Transport(){public JSONObject post(JSONObject body)throws Exception{super.post(body);return body.optBoolean("close")?new JSONObject().put("status",502).put("body",new JSONObject().put("code","ASR_FAILED").put("closed",true).toString()):response(new JSONObject());}};
   LiveSegmentPipe tail=new LiveSegmentPipe(failedTail,lastFailed,ID,null);tail.start(worker);check(tail.ready().get(3,TimeUnit.SECONDS),"tail ready");
   check(tail.close(false,5).get(3,TimeUnit.SECONDS)&&lastFailed.errors.equals(List.of("ASR_FAILED")),"failed last segment still confirms the server close");
   Transport unconfirmed=new Transport(){public JSONObject post(JSONObject body)throws Exception{super.post(body);return body.optBoolean("close")?new JSONObject().put("status",502).put("body",new JSONObject().put("code","ASR_FAILED").toString()):response(new JSONObject());}};
   LiveSegmentPipe noAck=new LiveSegmentPipe(unconfirmed,new Sink(),ID,null);noAck.start(worker);check(noAck.ready().get(3,TimeUnit.SECONDS),"noAck ready");check(!noAck.close(false,5).get(3,TimeUnit.SECONDS),"502 without closed is not a confirmed close");

   Sink full=new Sink();LiveSegmentPipe overflow=new LiveSegmentPipe(new Transport(),full,ID,null);
   for(int i=0;i<LiveSegmentPipe.MAX_QUEUED_FRAMES;i++)check(overflow.offer(frames(i),new JSONArray()),"bounded capacity");
   check(!overflow.offer(frames(LiveSegmentPipe.MAX_QUEUED_FRAMES),new JSONArray())&&full.errors.equals(List.of("BACKPRESSURE")),"overflow fails closed");overflow.start(worker);check(overflow.close(true,10).get(3,TimeUnit.SECONDS),"overflow cleanup");

   // A 2 s ASR stall (the POST carrying speech-end waits for the final) queues the speech behind it
   // without BACKPRESSURE: about 21 capture events of three 32 ms frames, then all of it is sent.
   CountDownLatch stalled=new CountDownLatch(1),finalReady=new CountDownLatch(1);
   Transport slowFinal=new Transport(){public JSONObject post(JSONObject body)throws Exception{if(!body.optBoolean("close")&&body.getJSONArray("frames").length()>0&&stalled.getCount()>0){stalled.countDown();await(finalReady);}return super.post(body);}};
   Sink patient=new Sink();LiveSegmentPipe stall=new LiveSegmentPipe(slowFinal,patient,ID,null);stall.start(worker);check(stall.ready().get(3,TimeUnit.SECONDS),"stall pipe ready");
   check(stall.offer(new JSONArray().put(frames(0).get(0)),new JSONArray().put(new JSONObject().put("type","speech-end").put("timestampMs",0))),"speech-end batch");await(stalled);
   int events=2000/96;
   for(int i=1;i<=events;i++){JSONArray three=new JSONArray();for(int f=0;f<3;f++)three.put(frames(i*96+f*32).get(0));check(stall.offer(three,new JSONArray()),"queued during stall "+i);}
   check(patient.errors.isEmpty(),"no BACKPRESSURE during a 2 s stall");
   finalReady.countDown();check(stall.close(false,Double.POSITIVE_INFINITY).get(3,TimeUnit.SECONDS),"stalled pipe closes");
   check(patient.errors.isEmpty()&&slowFinal.bodies.size()==events+3,"every queued batch sent after the stall");

   CountDownLatch staleFailure=new CountDownLatch(1);Transport changed=new Transport();Sink stale=new Sink(){public void failed(String code){super.failed(code);staleFailure.countDown();}};LiveSegmentPipe changedPipe=new LiveSegmentPipe(changed,stale,ID,null);changedPipe.start(worker);check(changedPipe.ready().get(3,TimeUnit.SECONDS),"original enrollment admitted");changed.current=false;await(staleFailure);
   check(!changedPipe.close(false,1).get(3,TimeUnit.SECONDS)&&changed.bodies.size()==1,"re-enrollment forbids further dispatch and cleanup using new authority");
   Sink refused=new Sink();ExecutorService stopped=Executors.newSingleThreadExecutor();stopped.shutdown();LiveSegmentPipe busy=new LiveSegmentPipe(new Transport(),refused,ID,null);
   check(!busy.start(stopped)&&refused.errors.equals(List.of("BUSY"))&&!busy.ready().get(1,TimeUnit.SECONDS)&&!busy.close(true,1).get(1,TimeUnit.SECONDS),"refused worker fails closed without dispatch");
   try{new LiveSegmentPipe(new Transport(),new Sink(),"not-a-session",null);throw new AssertionError("invalid session accepted");}catch(IllegalArgumentException expected){}
   System.out.println("PASS live segment pipe: cutoff, close, failed-tail close, cancel, bounded queue, re-enrollment, refused worker");
  }finally{worker.shutdownNow();}
 }
}
