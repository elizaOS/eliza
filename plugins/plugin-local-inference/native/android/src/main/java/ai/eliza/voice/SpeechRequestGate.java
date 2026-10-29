package ai.eliza.voice;

import java.net.HttpURLConnection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Admission of one speech bridge's requests (recognition, synthesis, status): at most one runs at
 * a time, none is admitted while a cancellation drain is open, and none after destroy.
 *
 * <p>A drain ({@link #beginDrain}) cancels every request and stays closed until the host's serial
 * worker barrier reports that cancelled work and its cleanup have finished ({@link #finishDrain}
 * with {@code complete}); a waiter that times out leaves the drain closed. Each {@link Request}
 * carries its own cancellation (an open connection, a native cancel hook) and its outcome.
 *
 * <p>No Android or Capacitor types: host-tested on the JVM.
 */
public final class SpeechRequestGate {
 /** One admitted request. Fields are written by its worker and read when it settles. */
 public static final class Request {
  public final String id;
  public volatile boolean cancelled,resolvedEarly,keepEngine;
  public volatile Runnable cancelNative,deadline;
  public volatile HttpURLConnection connection;
  /** The bridge's result value (for example a Capacitor JSObject). */
  public volatile Object result;
  public volatile String failure,failureCode;
  Request(String id){this.id=id;}
  /** Cancels the request; late output stays fenced even when native cancellation throws. */
  public void cancel(){
   cancelled=true;
   HttpURLConnection open=connection;if(open!=null)open.disconnect();
   Runnable nativeCancel=cancelNative;
   if(nativeCancel!=null)try{nativeCancel.run();}catch(RuntimeException ignored){/* Still fenced by cancelled. */}
  }
 }
 /** Why a request was not admitted. BUSY only when the caller asked not to replace playback. */
 public enum Refusal { BUSY, UNAVAILABLE }
 /** The admitted request, or the refusal. */
 public static final class Admission {
  public final Request request;public final Refusal refusal;
  private Admission(Request request,Refusal refusal){this.request=request;this.refusal=refusal;}
 }
 /** Outcome of {@link #beginDrain}. OPENED means the caller must run the barrier, then {@link #finishDrain}. */
 public enum Drain { UNAVAILABLE, JOINED, OPENED }

 private final Map<String,Request> pending=new ConcurrentHashMap<>();
 private final Map<Object,Runnable> waiters=new LinkedHashMap<>(); // Guarded by pending.
 private boolean draining,destroyed; // Guarded by pending.

 /** Admits {@code id} when nothing else runs; {@code replace=false} reports a busy speaker as BUSY. */
 public Admission admit(String id,boolean replace){
  synchronized(pending){
   if(destroyed||draining||!pending.isEmpty())return new Admission(null,!destroyed&&!draining&&!replace?Refusal.BUSY:Refusal.UNAVAILABLE);
   Request request=new Request(id);pending.put(id,request);return new Admission(request,null);
  }
 }
 public Request get(String id){return id==null?null:pending.get(id);}
 public boolean idle(){return pending.isEmpty();}
 /** Releases admission for exactly this request. */
 public void settle(Request request){pending.remove(request.id,request);}
 public void cancelAll(){for(Request request:pending.values())request.cancel();}
 public boolean draining(){synchronized(pending){return draining;}}
 public boolean destroyed(){synchronized(pending){return destroyed;}}
 /**
  * Cancels every request and adds {@code waiter} (with the host's {@code timeout}, which the host
  * schedules) to the drain. Only the first waiter opens it.
  */
 public Drain beginDrain(Object waiter,Runnable timeout){
  synchronized(pending){
   if(destroyed)return Drain.UNAVAILABLE;
   cancelAll();
   waiters.put(waiter,timeout);
   if(draining)return Drain.JOINED;
   draining=true;return Drain.OPENED;
  }
 }
 /** A waiter whose timeout fired leaves; true when it was still waiting. The drain stays closed. */
 public boolean leaveDrain(Object waiter){synchronized(pending){return waiters.remove(waiter)!=null;}}
 /** Releases every waiter (and returns them with their timeouts); {@code complete} reopens admission. */
 public Map<Object,Runnable> finishDrain(boolean complete){
  synchronized(pending){
   if(complete)draining=false;
   Map<Object,Runnable> released=new LinkedHashMap<>(waiters);waiters.clear();return released;
  }
 }
 /** Terminal: refuses everything from now on and cancels what runs. */
 public void destroy(){synchronized(pending){destroyed=true;}cancelAll();}
}
