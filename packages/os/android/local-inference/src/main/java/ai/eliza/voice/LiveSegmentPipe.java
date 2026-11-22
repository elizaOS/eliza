package ai.eliza.voice;

import java.util.ArrayDeque;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import org.json.*;

/**
 * Bounded in-memory route from a live capture's VAD segments to an agent's streaming ASR session
 * ({@code POST /api/asr/local-inference/live}). The host supplies the {@link Transport}: it posts
 * one JSON body to the agent of the owner who started the capture and {@link Transport#check}
 * throws once that owner, runtime or enrollment changed, so no audio, cleanup or retry ever reaches
 * a different owner. Nothing is persisted or retried. The session is warmed before the microphone
 * opens ({@link #ready}); {@link #cutoff} drops frames and VAD edges after an explicit Stop;
 * {@link #close} with discard drops queued audio and cancels the request in flight, otherwise the
 * captured tail is sent and the server close is acknowledged through the returned future.
 * Failures are reported once as BUSY, BACKPRESSURE, INVALID_AUDIO, TRANSPORT or ASR_FAILED.
 */
public final class LiveSegmentPipe {
 public interface Transport {void check()throws Exception;JSONObject post(JSONObject body)throws Exception;default void cancelInFlight(){}}
 public interface Sink {void result(JSONObject value);void failed(String code);}
 // The queue holds about 4 s of 32 ms frames, so a slow final (the POST carrying speech-end waits for
 // it) does not end the capture, with a hard cap on queued JSON.
 public static final int MAX_QUEUED_FRAMES=4000/32,MAX_QUEUED_CHARS=1024*1024,MAX_BATCH_CHARS=128*1024;
 private final Transport transport;private final Sink sink;private final String sessionId,roomId;
 private final ArrayDeque<String> queued=new ArrayDeque<>();
 private int queuedFrames,queuedChars;
 private final CompletableFuture<Boolean> closed=new CompletableFuture<>(),ready=new CompletableFuture<>();
 public CompletableFuture<Boolean> ready(){return ready;}
 private boolean closing,cancelled,finished;private double cutoff=Double.POSITIVE_INFINITY;
 public LiveSegmentPipe(Transport transport,Sink sink,String sessionId,String roomId){
  if(!sessionId.matches("[a-fA-F0-9-]{36}")||roomId!=null&&roomId.length()>128)throw new IllegalArgumentException("Invalid voice identity");
  this.transport=transport;this.sink=sink;this.sessionId=sessionId;this.roomId=roomId;
 }
 /** Starts draining on the executor; false (and BUSY) when it refuses the work. */
 public boolean start(Executor executor){try{executor.execute(this::drain);return true;}catch(RejectedExecutionException stopped){fail("BUSY");return false;}}
 public boolean offer(JSONArray frames,JSONArray vad){
  if(frames.length()==0&&vad.length()==0)return true;
  try{
   JSONObject batch=new JSONObject().put("frames",frames).put("vad",vad);
   String encoded=batch.toString();
   synchronized(this){
    if(closing||finished)return false;
    if(frames.length()<=32&&encoded.length()<=MAX_BATCH_CHARS&&queuedFrames+frames.length()<=MAX_QUEUED_FRAMES&&queuedChars+encoded.length()<=MAX_QUEUED_CHARS){
     queued.add(encoded);queuedFrames+=frames.length();queuedChars+=encoded.length();notifyAll();return true;
    }
   }
   fail("BACKPRESSURE");return false;
  }catch(Exception invalid){fail("INVALID_AUDIO");return false;}
 }
 public synchronized void cutoff(double at){cutoff=Math.min(cutoff,at);}
 public CompletableFuture<Boolean> close(boolean discard,double at){
  synchronized(this){cutoff=Math.min(cutoff,at);closing=true;cancelled|=discard;if(cancelled)clearQueue();notifyAll();}
  if(discard)transport.cancelInFlight();return closed;
 }

 private void fail(String code){
  boolean report;
  synchronized(this){report=!cancelled&&!finished;cancelled=true;closing=true;clearQueue();notifyAll();}
  try{transport.cancelInFlight();if(report)sink.failed(code);}
  finally{
   // Rejected work has no drainer. Failed cancellation or notification cannot strand these futures.
   if("BUSY".equals(code)){synchronized(this){finished=true;}ready.complete(false);closed.complete(false);}
  }
 }
 private void clearQueue(){queued.clear();queuedFrames=0;queuedChars=0;} // Under this lock.
 private JSONObject poll()throws JSONException{ // Under this lock.
  String encoded=queued.poll();if(encoded==null)return null;
  JSONObject batch=new JSONObject(encoded);queuedChars-=encoded.length();queuedFrames-=batch.getJSONArray("frames").length();return batch;
 }
 private JSONObject body(JSONObject batch)throws JSONException{
  JSONObject body=new JSONObject().put("sessionId",sessionId);if(roomId!=null)body.put("roomId",roomId);
  if(batch!=null){
   JSONArray frames=new JSONArray(),edges=new JSONArray();double limit;synchronized(this){limit=cutoff;}
   JSONArray source=batch.getJSONArray("frames"),vad=batch.getJSONArray("vad");
   for(int i=0;i<source.length();i++){JSONObject frame=source.getJSONObject(i);if(frame.getDouble("timestamp")<=limit)frames.put(frame);}
   for(int i=0;i<vad.length();i++){JSONObject edge=vad.getJSONObject(i);if(edge.getDouble("timestampMs")<=limit)edges.put(edge);}
   body.put("frames",frames).put("vad",edges);
  }else body.put("close",true);
  return body;
 }
 private void reply(JSONObject response)throws Exception{
  int status=response.getInt("status");JSONObject value=new JSONObject(response.getString("body"));
  synchronized(this){if(cancelled)return;}
  if(status==502&&"ASR_FAILED".equals(value.optString("code"))){sink.failed("ASR_FAILED");return;}
  if(status!=200)throw new IllegalStateException("ASR route unavailable");
  JSONObject finalValue=value.optJSONObject("final");if(finalValue==null)return;
  if(!(finalValue.opt("turnId") instanceof String)||!(finalValue.opt("text") instanceof String))throw new IllegalStateException("Invalid transcript");
  String turn=finalValue.getString("turnId"),text=finalValue.getString("text");
  if(turn.isEmpty()||turn.length()>128||text.length()>65536)throw new IllegalStateException("Invalid transcript");
  JSONObject projected=new JSONObject().put("turnId",turn).put("text",text).put("mode",finalValue.optString("mode","unknown"));
  double latency=finalValue.optDouble("asrFinalFromSpeechEndMs",Double.NaN);
  if(Double.isFinite(latency)&&latency>=0&&latency<3600000)projected.put("asrFinalFromSpeechEndMs",latency);
  synchronized(this){if(cancelled)return;}
  sink.result(projected);
 }
 private void drain(){
  boolean serverClosed=false;
  try{
   boolean abandoned;synchronized(this){abandoned=closing;}
   if(!abandoned){
    transport.check();JSONObject warm=body(new JSONObject().put("frames",new JSONArray()).put("vad",new JSONArray()));
    JSONObject response=transport.post(warm);transport.check();
    if(response.optInt("status")!=200)throw new IllegalStateException("ASR startup unavailable");
    reply(response);ready.complete(true);
   }else ready.complete(false);
   for(;;){
    JSONObject batch;
    synchronized(this){if(queued.isEmpty()&&!closing)wait(250);batch=poll();if(batch==null&&closing)break;}
    transport.check();
    if(batch==null)continue;
    synchronized(this){if(cancelled)continue;}
    JSONObject request=body(batch);
    if(request.getJSONArray("frames").length()==0&&request.getJSONArray("vad").length()==0)continue;
    JSONObject response=transport.post(request);transport.check();reply(response);
   }
  }catch(Exception failure){fail("TRANSPORT");}
  finally{
   ready.complete(false);
   // A failed last segment still closes the server session (502 ASR_FAILED with closed).
   try{transport.check();JSONObject response=transport.post(body(null));transport.check();reply(response);int status=response.optInt("status");JSONObject value=new JSONObject(response.getString("body"));serverClosed=(status==200||status==502&&"ASR_FAILED".equals(value.optString("code")))&&value.optBoolean("closed");}
   catch(Exception unavailable){/* A changed enrollment must never receive even this cleanup. */}
   synchronized(this){finished=true;clearQueue();}
   closed.complete(serverClosed);
  }
 }
}
