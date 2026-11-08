package ai.eliza.voice;

import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;

/**
 * On-device speech readiness by part. {@link #ready} means recognition and speech output both load;
 * {@link #playback} means speech output loads. A failed check names a stable {@link #reason}:
 * {@link #BUNDLE_ABSENT} (the build carries no voice bundle; nothing native is loaded),
 * {@link #STORAGE} (the bundle could not be installed or verified) or {@link #ENGINE_LOAD_FAILED}
 * (a model or the native library did not load). Cancellation is not a readiness answer: it throws.
 */
public final class LocalSpeechReadiness {
 public static final String BUNDLE_ABSENT="bundle-absent",STORAGE="storage",ENGINE_LOAD_FAILED="engine-load-failed";
 public interface Check { boolean run()throws Exception; }
 public interface Step { void run()throws Exception; }
 public final boolean ready,playback;
 /** Null when ready. */
 public final String reason;
 private LocalSpeechReadiness(boolean ready,boolean playback,String reason){this.ready=ready;this.playback=playback;this.reason=reason;}

 /**
  * Runs {@code packaged}, then {@code install}, then {@code voice} and {@code recognition}, stopping
  * at the first part that fails. A failure while {@code cancelled} throws CancellationException.
  */
 public static LocalSpeechReadiness check(Check packaged,Step install,Step voice,Step recognition,BooleanSupplier cancelled){
  boolean present;
  try{present=packaged.run();}catch(Exception|LinkageError error){return failed(cancelled,false,STORAGE);}
  if(!present)return failed(cancelled,false,BUNDLE_ABSENT);
  if(!passes(install,cancelled))return failed(cancelled,false,STORAGE);
  if(!passes(voice,cancelled))return failed(cancelled,false,ENGINE_LOAD_FAILED);
  if(!passes(recognition,cancelled))return failed(cancelled,true,ENGINE_LOAD_FAILED);
  if(cancelled.getAsBoolean())throw new CancellationException();
  return new LocalSpeechReadiness(true,true,null);
 }
 private static boolean passes(Step step,BooleanSupplier cancelled){
  if(cancelled.getAsBoolean())throw new CancellationException();
  try{step.run();return true;}catch(CancellationException ended){throw ended;}catch(Exception|LinkageError|OutOfMemoryError error){return false;}
 }
 private static LocalSpeechReadiness failed(BooleanSupplier cancelled,boolean playback,String reason){
  if(cancelled.getAsBoolean())throw new CancellationException();
  return new LocalSpeechReadiness(false,playback,reason);
 }
}
