// spec/os/voice/microphone.md, "Story: Share the microphone between live capture and dictation"
// Copied from eliza-develop plugins/plugin-local-inference/native/android/src/main/java/ai/eliza/voice/LiveCaptureResource.java
package ai.eliza.voice;

public final class LiveCaptureResource {
 public interface Source { void requestStop(); void close(); }
 private final LocalMicrophoneLease.Slot slot;
 private Source active;
 private volatile LocalMicrophoneLease microphone;
 private volatile boolean stopped;
 private boolean releaseFailed;
 public LiveCaptureResource(){this(LocalMicrophoneLease.PROCESS);}
 public LiveCaptureResource(LocalMicrophoneLease.Slot slot){this.slot=slot;}
 public void cancel(){stopped=true;LocalMicrophoneLease held=microphone;if(held!=null)held.cancel();}
 public boolean stopped(){return stopped;}
 LocalMicrophoneLease microphone(){return microphone;}
 public synchronized void reserveMicrophone(boolean reopen){
  if(stopped)throw new IllegalStateException("Live capture stopped");
  if(microphone!=null)throw new IllegalStateException("Live capture already reserved the microphone");
  microphone=slot.reserve(LocalMicrophoneLease.User.LIVE_CAPTURE,reopen,this::requestStop);
 }
 public synchronized boolean openFailed(boolean releaseConfirmed){
  LocalMicrophoneLease held=microphone;
  if(held==null)return false;
  if(!releaseConfirmed){releaseFailed=true;return held.releaseUnconfirmed();}
  held.cancel();
  if(!held.release())return false;
  microphone=null;return true;
 }
 public synchronized boolean attach(Source source){
  if(stopped)return false;
  if(active!=null)throw new IllegalStateException("Capture source already attached");
  if(microphone==null||!microphone.opened())return false;
  active=source;return true;
 }
 public synchronized boolean requestStop(){
  stopped=true;
  LocalMicrophoneLease held=microphone;
  boolean cancelled=held!=null&&held.cancel();
  if(active!=null)try{active.requestStop();}catch(RuntimeException unavailable){/* Worker still owns release. */}
  return cancelled;
 }
 public synchronized boolean release(Source source){
  LocalMicrophoneLease held=microphone;
  if(held!=null)held.cancel();
  try{source.close();if(active==source)active=null;}
  catch(RuntimeException|Error failure){releaseFailed=true;if(held!=null)held.releaseUnconfirmed();throw failure;}
  if(active!=null||held==null||!held.release())return false;
  microphone=null;return true;
 }
 public synchronized boolean released(){return active==null&&microphone==null&&!releaseFailed;}
}
