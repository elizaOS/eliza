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

   Sink full=new Sink();LiveSegmentPipe overflow=new LiveSegmentPipe(new Transport(),full,ID,null);
   for(int i=0;i<LiveSegmentPipe.MAX_BATCHES;i++)check(overflow.offer(frames(i),new JSONArray()),"bounded capacity");
   check(!overflow.offer(frames(9),new JSONArray())&&full.errors.equals(List.of("BACKPRESSURE")),"overflow fails closed");overflow.start(worker);check(overflow.close(true,10).get(3,TimeUnit.SECONDS),"overflow cleanup");

   CountDownLatch staleFailure=new CountDownLatch(1);Transport changed=new Transport();Sink stale=new Sink(){public void failed(String code){super.failed(code);staleFailure.countDown();}};LiveSegmentPipe changedPipe=new LiveSegmentPipe(changed,stale,ID,null);changedPipe.start(worker);check(changedPipe.ready().get(3,TimeUnit.SECONDS),"original enrollment admitted");changed.current=false;await(staleFailure);
   check(!changedPipe.close(false,1).get(3,TimeUnit.SECONDS)&&changed.bodies.size()==1,"re-enrollment forbids further dispatch and cleanup using new authority");
   Sink refused=new Sink();ExecutorService stopped=Executors.newSingleThreadExecutor();stopped.shutdown();LiveSegmentPipe busy=new LiveSegmentPipe(new Transport(),refused,ID,null);
   check(!busy.start(stopped)&&refused.errors.equals(List.of("BUSY"))&&!busy.ready().get(1,TimeUnit.SECONDS)&&!busy.close(true,1).get(1,TimeUnit.SECONDS),"refused worker fails closed without dispatch");
   try{new LiveSegmentPipe(new Transport(),new Sink(),"not-a-session",null);throw new AssertionError("invalid session accepted");}catch(IllegalArgumentException expected){}
   System.out.println("PASS live segment pipe: cutoff, close, cancel, bounded queue, re-enrollment, refused worker");
  }finally{worker.shutdownNow();}
 }
}
