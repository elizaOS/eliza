// spec/os/voice/microphone.md, "Story: Share the microphone between live capture and dictation"
// Copied from eliza-develop plugins/plugin-local-inference/native/android/src/main/java/ai/eliza/voice/LiveCaptureOptions.java
package ai.eliza.voice;

/**
 * What one live capture was asked for, in whole VAD windows ({@link #WINDOW_MS}). Pure: the host
 * JVM test evaluates it directly.
 *
 * <ul>
 * <li>{@code echoCancel}: a conversation capture (see {@link LiveCaptureSource}).</li>
 * <li>{@code startWindows}/{@code endWindows}: the gate's start run and end hangover. The hangover is
 *     clamped to {@link #END_MIN_MS}..{@link #END_MAX_MS}; the start run never exceeds the pre-roll,
 *     so the opening syllable is kept.</li>
 * <li>{@code bargeIn}: report speech sustained for {@code bargeInWindows} while the reply plays.</li>
 * <li>{@code reopen}: the automatic reopen after a busy hold, which the microphone slot refuses
 *     while a draft request fences it.</li>
 * </ul>
 */
public final class LiveCaptureOptions {
 public static final int WINDOW_MS=32,START_WINDOWS=2,END_WINDOWS=16;
 public static final int START_MIN_MS=32,START_MAX_MS=256,END_MIN_MS=96,END_MAX_MS=1024,BARGE_IN_MS=300,BARGE_IN_MIN_MS=64,BARGE_IN_MAX_MS=2000;
 public final boolean echoCancel,bargeIn,reopen;
 public final int startWindows,endWindows,bargeInWindows;
 private LiveCaptureOptions(boolean echoCancel,int startWindows,int endWindows,boolean bargeIn,int bargeInWindows,boolean reopen){
  this.echoCancel=echoCancel;this.startWindows=startWindows;this.endWindows=endWindows;this.bargeIn=bargeIn;this.bargeInWindows=bargeInWindows;this.reopen=reopen;
 }
 /** The gate defaults, without barge-in reports. */
 public static LiveCaptureOptions of(boolean echoCancel){return of(echoCancel,null,null,false,null);}
 /** Null durations keep the defaults; others are clamped and rounded to whole windows. */
 public static LiveCaptureOptions of(boolean echoCancel,Integer startMs,Integer endHangoverMs,boolean bargeIn,Integer bargeInMs){
  return new LiveCaptureOptions(echoCancel,
   startMs==null?START_WINDOWS:windows(startMs,START_MIN_MS,START_MAX_MS),
   endHangoverMs==null?END_WINDOWS:windows(endHangoverMs,END_MIN_MS,END_MAX_MS),
   bargeIn,windows(bargeInMs==null?BARGE_IN_MS:bargeInMs,BARGE_IN_MIN_MS,BARGE_IN_MAX_MS),false);
 }
 /** The same request as an automatic reopen ({@code true}) or a start the person made ({@code false}). */
 public LiveCaptureOptions reopening(boolean reopen){return new LiveCaptureOptions(echoCancel,startWindows,endWindows,bargeIn,bargeInWindows,reopen);}
 static int windows(int ms,int minimum,int maximum){return Math.round(Math.max(minimum,Math.min(maximum,ms))/(float)WINDOW_MS);}
 public int startMs(){return startWindows*WINDOW_MS;}
 public int endHangoverMs(){return endWindows*WINDOW_MS;}
 public int bargeInMs(){return bargeInWindows*WINDOW_MS;}
}
