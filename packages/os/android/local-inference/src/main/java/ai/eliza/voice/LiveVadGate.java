package ai.eliza.voice;

/**
 * Speech segment edges from Silero VAD probabilities (one per 512-sample window at 16 kHz, 32 ms).
 * Pure state: {@link LiveVoiceCapture} feeds it the libelizainference VAD output and forwards the
 * edges with the audio to the host's live ASR route.
 *
 * <p>A segment opens after {@code startWindows} consecutive windows at or above {@link #START}
 * and closes after {@code endWindows} consecutive windows below {@link #END}. The defaults are
 * {@link #START_WINDOWS} and {@link #END_WINDOWS} (about 512 ms of trailing silence, the latency
 * budget of a spoken turn); a conversation that submits its turn at a shorter pause passes its own.
 * While a segment is closed, the last {@link #PREROLL_WINDOWS} windows are kept so the opening
 * syllable reaches the decoder.
 */
public final class LiveVadGate {
 public static final int WINDOW = 512;
 /** Duration of one window at 16 kHz. */
 public static final int WINDOW_MS = 32;
 public static final float START = 0.5f, END = 0.35f;
 public static final int START_WINDOWS = 2, END_WINDOWS = 16, PREROLL_WINDOWS = 10;
 /** No edge, segment opened (at this window minus the start run), segment closed. */
 public enum Edge { NONE, SPEECH_START, SPEECH_END }
 private final int startWindows,endWindows;
 private boolean speaking;
 private int above, below, run;
 public LiveVadGate(){this(START_WINDOWS,END_WINDOWS);}
 public LiveVadGate(int startWindows,int endWindows){
  if(startWindows<1||startWindows>PREROLL_WINDOWS||endWindows<1)throw new IllegalArgumentException("Invalid VAD windows");
  this.startWindows=startWindows;this.endWindows=endWindows;
 }
 public boolean speaking(){return speaking;}
 /** Consecutive windows at or above {@link #START} up to the last one, inside or outside a segment. */
 public int speechRun(){return run;}
 public Edge accept(float probability){
  if(!Float.isFinite(probability))probability=0f;
  run=probability>=START?Math.min(run+1,Integer.MAX_VALUE-1):0;
  if(!speaking){
   above=probability>=START?above+1:0;
   if(above>=startWindows){speaking=true;above=0;below=0;return Edge.SPEECH_START;}
   return Edge.NONE;
  }
  below=probability<END?below+1:0;
  if(below>=endWindows){speaking=false;below=0;above=0;return Edge.SPEECH_END;}
  return Edge.NONE;
 }
 /** End an open segment now (capture stopped while speaking). */
 public boolean close(){boolean was=speaking;speaking=false;above=0;below=0;run=0;return was;}
}
