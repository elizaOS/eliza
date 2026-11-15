package ai.eliza.voice;

import java.util.concurrent.atomic.AtomicReference;

/** One in-process owner for shared local speech recordings and live capture. */
final class LocalMicrophoneLease {
 private static final AtomicReference<LocalMicrophoneLease> active=new AtomicReference<>();
 private LocalMicrophoneLease(){}

 static LocalMicrophoneLease acquire(){
  LocalMicrophoneLease lease=new LocalMicrophoneLease();
  if(!active.compareAndSet(null,lease))throw new IllegalStateException("Microphone is in use");
  return lease;
 }

 /** Only the exact owner can release its reservation after source cleanup. */
 void release(){active.compareAndSet(this,null);}
}
