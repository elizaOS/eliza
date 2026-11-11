package ai.eliza.voice;

/** Serializes stop with release, including a source that finishes opening after cancellation. */
public final class LiveCaptureResource {
 public interface Source { void requestStop(); void close(); }
 private Source active;
 private LocalMicrophoneLease microphone;
 private volatile boolean stopped;
 private boolean releaseFailed;
 public void cancel(){stopped=true;}
 public boolean stopped(){return stopped;}
 synchronized void reserveMicrophone(){
  if(stopped)throw new IllegalStateException("Live capture stopped");
  microphone=LocalMicrophoneLease.acquire();
 }
 synchronized void openFailed(boolean releaseConfirmed){
  if(releaseConfirmed)releaseMicrophone();
  else releaseFailed=true;
 }
 private void releaseMicrophone(){
  if(microphone!=null){microphone.release();microphone=null;}
 }
 public synchronized boolean attach(Source source){
  if(stopped)return false;
  if(active!=null)throw new IllegalStateException("Capture source already attached");
  active=source;return true;
 }
 public synchronized void requestStop(){
  stopped=true;
  if(active!=null)try{active.requestStop();}catch(RuntimeException unavailable){/* Worker still owns release. */}
 }
 /** Called only by the capture worker (or the opener when no worker was started). */
 public synchronized void release(Source source){
  try{source.close();if(active==source)active=null;if(active==null)releaseMicrophone();}
  catch(RuntimeException|Error failure){releaseFailed=true;throw failure;}
 }
 /** A failed physical close is never a receipt permitting a replacement. */
 public synchronized boolean released(){return active==null&&microphone==null&&!releaseFailed;}
}
