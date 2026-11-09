package ai.eliza.voice;

import java.util.Collection;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * One host's live microphone capture with VAD ({@link LiveVoiceCapture}) and, when the host asks
 * for it, the bounded route of its VAD segments to the owner's agent ({@link LiveSegmentPipe}).
 * A plugin keeps only its bridge, permission prompt and lifecycle; this class owns the ordering:
 *
 * <ul>
 *   <li>{@link #reserve} takes the per-capture admission before the permission prompt, so a Stop,
 *       pause or replacement during the prompt or native startup cancels it without waiting.
 *   <li>{@link #start} (on the capture worker) replaces any running capture, warms the agent's ASR
 *       session before the microphone opens, publishes cancellation before native startup and
 *       re-checks the host's gate after it.
 *   <li>Frames, transcripts and end events reach the host only while the capture's admission and
 *       the host's {@link Host#open} gate for its epoch both hold. Piped frames are never handed to
 *       the host (the host receives an empty frame list with the VAD edges and level).
 *   <li>{@link #stop} applies the Stop cutoff to the pipe immediately and reports whether the agent
 *       acknowledged the server-side close; discard drops the captured tail.
 *   <li>A pipe failure before the start is reported refuses the start with the failure code
 *       instead of ending a capture the host never saw.
 *   <li>{@link #cancelAll} (pause, destroy) discards everything; a pause first reports the running
 *       capture ended ({@link #PAUSED}), and {@link #pause} keeps a reservation held by a permission
 *       prompt. {@link #interrupt} ends the running capture with a reason (for example a phone call)
 *       without blocking the caller, and refuses a start still in progress with that reason. Each,
 *       even with no capture running, refuses an automatic reopen until a user-initiated start.
 * </ul>
 *
 * No Capacitor types: hosts adapt {@link Host}, {@link Started} and {@link Stopped} to their bridge.
 */
public final class LiveCaptureController {
 /** The host's lifecycle gate and event sink. Event methods may run on capture threads. */
 public interface Host {
  /** True while the host may deliver events for a capture admitted at {@code epoch}. */
  boolean open(long epoch);
  /** Startup may be stricter than delivery of an interrupted capture. */
  default boolean canStart(long epoch){return open(epoch);}
  /** The capture for {@code id} (normally {@code new LiveVoiceCapture(context,inference,id,sink,echoCancel)}). */
  LiveVoiceCapture capture(String id,LiveVoiceCapture.Sink sink,boolean echoCancel)throws Exception;
  void frames(String id,JSONArray frames,JSONArray vad,float peak);
  void ended(String id,String error);
  /** A piped final transcript ({@code error} null) or a pipe failure code ({@code value} null). */
  default void transcript(String id,JSONObject value,String error){}
 }
 /** Opens the owner-bound transport for one capture's pipe; throws when no owner is enrolled. */
 public interface Route { LiveSegmentPipe.Transport open()throws Exception; }
 public interface Started {
  void started(String id,int sampleRate,boolean echoCancelled,boolean piped);
  void refused(String message,String code);
 }
 public interface Stopped { void stopped(String id,long durationMs,boolean serverClosed); }

 public static final String CANCELLED="Recording cancelled",CAPTURE="capture",PAUSED="paused";
 static final String INTERRUPTED="Voice was interrupted",SESSION_UNAVAILABLE="Agent voice session unavailable";
 static final long PIPE_READY_MS=10000,PIPE_CLOSE_MS=12000;

 private final Host host;
 private final ExecutorService worker=Executors.newSingleThreadExecutor();
 // One thread plus one waiting slot: a pipe completes its close before its drain thread returns to the
 // pool, so a back-to-back start (or an interrupt right after a stop) waits for that thread instead of
 // being refused as busy. A second waiting task is still refused rather than queued without bound.
 private final ExecutorService stopWorker=new ThreadPoolExecutor(1,1,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(1));
 private final ExecutorService pipeWorker=new ThreadPoolExecutor(1,1,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(1));
 private final LiveCaptureAdmission admission=new LiveCaptureAdmission();
 private final Map<String,LiveSegmentPipe> pipes=new ConcurrentHashMap<>();
 private LiveVoiceCapture live; // Confined to worker.
 private volatile LiveVoiceCapture current; // The running capture, for interruption off worker.
 private volatile String interrupted; // A call or pause since this host's last capture: an automatic reopen is refused.

 public LiveCaptureController(Host host){this.host=host;}

 /** Reserves the admission for {@code id} at the host's {@code epoch}, cancelling any earlier one. */
 public LiveCaptureAdmission.Ticket reserve(String id,long epoch){return admission.begin(id,epoch);}
 /** False once the reservation was stopped, replaced or cancelled (for example after a permission prompt). */
 public boolean current(LiveCaptureAdmission.Ticket ticket){return admission.current(ticket);}
 /** Refuses a reservation that is no longer current: interrupted (its reason) or cancelled. */
 public void refuse(LiveCaptureAdmission.Ticket ticket,Started result){refuse(ticket,new Startup(),result);}

 /**
  * Starts the reserved capture on the capture worker. With a {@code route}, VAD segments go to the
  * agent session {@code ticket.id} (room {@code roomId}) instead of the host. A {@code reopen} (the
  * automatic reopen after a busy hold) is refused after a call or pause since the last capture; a
  * user-initiated start clears that.
  */
 public void start(LiveCaptureAdmission.Ticket ticket,boolean echoCancel,Route route,String roomId,boolean reopen,Started result){
  final String id=ticket.id;final long epoch=ticket.epoch;
  submit(worker,()->{
   String since=interrupted;
   if(reopen&&since!=null){result.refused(CANCELLED.equals(since)?CANCELLED:INTERRUPTED,CANCELLED.equals(since)?null:since);return;}
   if(!reopen)interrupted=null;
   final Startup startup=new Startup();
   if(!host.canStart(epoch)||!admission.current(ticket)){refuse(ticket,startup,result);return;}
   if(live!=null){String old=live.captureId();live.stop();live=null;current=null;closePipe(old,true,now());}
   final LiveSegmentPipe pipe;
   try{
    pipe=route==null?null:new LiveSegmentPipe(route.open(),new LiveSegmentPipe.Sink(){
     public void result(JSONObject value){if(host.open(epoch)&&admission.events(ticket))host.transcript(id,value,null);}
     public void failed(String code){
      if(!admission.events(ticket))return;
      boolean asr="ASR_FAILED".equals(code);
      if(!asr&&startup.hold(code))return;
      if(!asr)admission.stop(id);host.transcript(id,null,code);
     }
    },id,roomId);
    if(pipe!=null){
     pipes.put(id,pipe);
     if(!pipe.start(pipeWorker)){pipes.remove(id,pipe);result.refused("Native voice transport busy",null);return;}
     // An interrupt before the pipe was published could not close it: stop waiting for the agent.
     if(!admission.current(ticket))throw new IllegalStateException(CANCELLED);
     if(!pipe.ready().get(PIPE_READY_MS,TimeUnit.MILLISECONDS))throw new IllegalStateException("Agent voice session unavailable");
    }
   }catch(Exception unavailable){
    closePipe(id,true,now());
    // A Stop, pause or replacement while the agent session warmed is a cancellation, not an enrollment failure.
    if(startup.failure()==null&&host.canStart(epoch)&&admission.current(ticket))result.refused("Native voice enrollment unavailable",null);
    else refuse(ticket,startup,result);
    return;
   }
   if(!host.canStart(epoch)||!admission.current(ticket)){closePipe(id,true,now());refuse(ticket,startup,result);return;}
   final LiveVoiceCapture next;
   try{
    next=host.capture(id,new LiveVoiceCapture.Sink(){
     private boolean admitted(){return host.open(epoch)&&admission.events(ticket);}
     public void frames(String captureId,JSONArray frames,JSONArray vad,float peak){if(!admitted())return;host.frames(captureId,pipe==null?frames:new JSONArray(),vad,peak);if(pipe!=null)pipe.offer(frames,vad);}
     public void ended(String captureId,String error){if(!host.open(epoch)||!admission.end(ticket))return;host.ended(captureId,error);if(error!=null&&pipe!=null)pipe.close(true,now());}
    },echoCancel);
   }catch(Exception|Error unavailable){closePipe(id,true,now());result.refused("Live capture could not start",CAPTURE);return;}
   // Publish cancellation before native startup. The callback only marks and schedules: no join on the caller.
   if(!admission.attach(ticket,()->{next.cancelPending();if(pipe!=null&&!admission.events(ticket))pipe.close(true,now());submit(stopWorker,next::requestStop,()->{/* The capture worker's cleanup still stops this source. */});})){closePipe(id,true,now());refuse(ticket,startup,result);return;}
   try{
    next.start();
    // Published before the ticket runs: an interrupt either refuses this start or reaches the capture.
    current=next;
    if(!host.canStart(epoch)||!admission.run(ticket)||!startup.report()){admission.discard(ticket);current=null;next.stop();closePipe(id,true,now());refuse(ticket,startup,result);return;}
    live=next;result.started(id,LiveVoiceCapture.SAMPLE_RATE,next.echoCancelled(),pipe!=null);
   }catch(Exception|Error failure){
    current=null;next.stop();closePipe(id,true,now());
    // A cancellation or call during native startup fails it on purpose: refuse with that cause.
    if(host.canStart(epoch)&&admission.current(ticket))result.refused("Live capture could not start",CAPTURE);else refuse(ticket,startup,result);
   }
  },()->result.refused("Voice unavailable",null));
 }

 /**
  * Stops {@code id}. Frames and VAD edges after {@code cutoffMs} (wall clock) never reach the agent;
  * {@code discard} drops the tail. {@code serverClosed} is false when the agent did not confirm the close.
  */
 public void stop(String id,boolean discard,double cutoffMs,Stopped result){
  final double cutoff=Double.isFinite(cutoffMs)?cutoffMs:now();
  LiveSegmentPipe pipe=pipes.get(id);
  if(pipe!=null)pipe.cutoff(cutoff);
  // Cancelling transport can immediately wake the startup worker. Publish Stop first so that
  // worker observes cancellation when classifying an interrupted warm-up.
  admission.stop(id,discard);
  if(pipe!=null&&(discard||!pipe.ready().isDone()))pipe.close(true,cutoff);
  submit(worker,()->{
   long duration=0;
   if(live!=null&&live.captureId().equals(id)){duration=live.stop();live=null;current=null;}
   result.stopped(id,duration,closePipe(id,discard,cutoff));
  },()->result.stopped(id,0,false));
 }

 /** Pause: cancels the reservation and discards the running capture and its pipe. */
 public void cancelAll(){pause(Collections.emptySet());}
 /**
  * Pause while {@code waiting} reservations are held by a permission prompt: they stay admitted,
  * and anything running stops. The running capture is reported ended ({@link #PAUSED}) first.
  */
 public void pause(Collection<LiveCaptureAdmission.Ticket> waiting){end(waiting,true);}
 private void end(Collection<LiveCaptureAdmission.Ticket> waiting,boolean report){
  interrupted=CANCELLED;
  LiveCaptureAdmission.Ticket ended=admission.pause(waiting);
  if(report&&ended!=null)host.ended(ended.id,PAUSED);
  for(LiveSegmentPipe pipe:pipes.values())pipe.close(true,now());
  submit(worker,()->{if(live!=null){live.stop();live=null;current=null;}for(String id:pipes.keySet())closePipe(id,true,now());},()->{/* Shut down: its last task stopped the capture. */});
 }

 /**
  * Ends the running capture with {@code reason} (reported through {@link Host#ended}), or refuses
  * a start still in progress with {@code reason} as its code; never blocks.
  */
 public void interrupt(String reason){
  interrupted=reason;
  LiveCaptureAdmission.Ticket pending=admission.interrupt(reason);
  // A start still warming the agent session stops waiting for it.
  LiveSegmentPipe warming=pending==null?null:pipes.get(pending.id);
  if(warming!=null)warming.close(true,now());
  LiveVoiceCapture active=current;
  if(active!=null)submit(stopWorker,()->active.interrupt(reason),()->{/* Shut down: the capture already stopped. */});
 }

 /** Runs {@code work} on the capture worker (serialized with start/stop), else {@code refused} on the caller. */
 public void onWorker(Runnable work,Runnable refused){submit(worker,work,refused);}

 /** Terminal: cancels everything and stops the workers after their queued cleanup. */
 public void shutdown(){end(Collections.emptySet(),false);worker.shutdown();stopWorker.shutdown();pipeWorker.shutdown();}

 /** A refused start: interrupted (its reason), failed in the pipe (its code) or cancelled. */
 private void refuse(LiveCaptureAdmission.Ticket ticket,Startup startup,Started result){
  String reason=admission.reason(ticket),failure=startup.failure();
  if(reason!=null)result.refused(INTERRUPTED,reason);
  else if(failure!=null){admission.discard(ticket);result.refused(SESSION_UNAVAILABLE,failure);}
  else result.refused(CANCELLED,null);
 }
 /** Holds a pipe failure until the start is reported, so it refuses the start instead. */
 private static final class Startup {
  private String failure;private boolean reported;
  synchronized boolean hold(String code){if(reported)return false;if(failure==null)failure=code;return true;}
  synchronized String failure(){return failure;}
  /** False when a failure was held: the start is refused. */
  synchronized boolean report(){if(failure!=null)return false;reported=true;return true;}
 }

 /** Waits only on the capture worker, never a bridge or UI thread. False: server close unconfirmed. */
 private boolean closePipe(String id,boolean discard,double at){
  LiveSegmentPipe pipe=pipes.get(id);if(pipe==null)return true;
  try{return pipe.close(discard,at).get(PIPE_CLOSE_MS,TimeUnit.MILLISECONDS);}
  catch(Exception uncertain){pipe.close(true,at);return false;}
  finally{pipes.remove(id,pipe);}
 }
 private static double now(){return System.currentTimeMillis();}
 private static void submit(Executor executor,Runnable work,Runnable refused){
  try{executor.execute(work);}catch(RejectedExecutionException stopped){refused.run();}
 }
}
