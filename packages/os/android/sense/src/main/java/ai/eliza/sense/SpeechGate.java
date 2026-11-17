package ai.eliza.sense;

import java.util.Arrays;

/**
 * Local voice-activity detection and turn segmentation over 16 kHz mono PCM16 frames of
 * {@link #FRAME_SAMPLES} samples. An adaptive noise floor tracks the room; a frame is speech when
 * it is clearly above that floor and above an absolute level. An utterance starts after a short run
 * of speech (with pre-roll so the first syllable survives) and ends after a silence hangover or at
 * the maximum length.
 *
 * Audio exists only in this object's RAM buffers and in the array handed to the sink, which the
 * caller must zero after use. Discarded audio is zeroed here. Nothing is written to storage.
 * Pure Java; not thread-safe (one capture thread owns it).
 */
public final class SpeechGate {
 public static final int SAMPLE_RATE=16_000;
 public static final int FRAME_SAMPLES=320; // 20 ms
 static final int START_FRAMES=3;           // 60 ms of speech opens an utterance
 static final int PREROLL_FRAMES=15;        // 300 ms kept before the start
 static final int HANGOVER_FRAMES=35;       // 700 ms of silence closes it
 static final int MIN_SPEECH_FRAMES=15;     // under 300 ms of speech is discarded
 public static final int MAX_FRAMES=400;    // 8 s cap per utterance
 static final double MARGIN_DB=9.0;
 static final double ABSOLUTE_FLOOR_DBFS=-50.0;

 public interface Sink { void onUtterance(float[] mono16k); }

 private final Sink sink;
 private final short[][] preroll=new short[PREROLL_FRAMES][FRAME_SAMPLES];
 private int prerollCount,prerollNext;
 private final float[] utterance=new float[MAX_FRAMES*FRAME_SAMPLES];
 private int utteranceFrames,speechFrames,silenceRun,speechRun;
 private boolean active;
 private double noiseFloorDb=-60.0;

 public SpeechGate(Sink sink){this.sink=sink;}

 /** RMS level of a PCM16 frame in dBFS (−120 for digital silence). */
 public static double levelDbfs(short[] frame,int offset,int length){
  if(length<=0)return -120.0;
  double sum=0;
  for(int i=0;i<length;i++){double sample=frame[offset+i]/32768.0;sum+=sample*sample;}
  double rms=Math.sqrt(sum/length);
  return rms<=1e-6?-120.0:20.0*Math.log10(rms);
 }

 boolean isSpeech(double levelDb){return levelDb>ABSOLUTE_FLOOR_DBFS&&levelDb>noiseFloorDb+MARGIN_DB;}

 double noiseFloorDb(){return noiseFloorDb;}

 /** Feed exactly one frame of {@link #FRAME_SAMPLES} samples. */
 public void accept(short[] frame){
  if(frame==null||frame.length!=FRAME_SAMPLES)throw new IllegalArgumentException("frame");
  double level=levelDbfs(frame,0,FRAME_SAMPLES);
  boolean speech=isSpeech(level);
  // The floor drops quickly into quieter rooms and rises slowly, so steady loud noise (a fan, a
  // car) stops counting as speech while ordinary pauses between words pull it back down.
  noiseFloorDb+=(level-noiseFloorDb)*(level<noiseFloorDb?0.3:speech?0.001:0.005);
  if(!active){
   speechRun=speech?speechRun+1:0;
   pushPreroll(frame);
   if(speechRun>=START_FRAMES)open();
   return;
  }
  append(frame);
  if(speech){speechFrames++;silenceRun=0;}else silenceRun++;
  if(silenceRun>=HANGOVER_FRAMES||utteranceFrames>=MAX_FRAMES)close();
 }

 /** Drops any partial utterance (pause, call, stop) and zeroes every buffer. */
 public void reset(){
  for(short[] row:preroll)Arrays.fill(row,(short)0);
  Arrays.fill(utterance,0f);
  prerollCount=prerollNext=utteranceFrames=speechFrames=silenceRun=speechRun=0;
  active=false;
 }

 private void pushPreroll(short[] frame){
  System.arraycopy(frame,0,preroll[prerollNext],0,FRAME_SAMPLES);
  prerollNext=(prerollNext+1)%PREROLL_FRAMES;
  if(prerollCount<PREROLL_FRAMES)prerollCount++;
 }

 private void open(){
  active=true;utteranceFrames=0;silenceRun=0;speechFrames=speechRun;speechRun=0;
  int start=(prerollNext-prerollCount+PREROLL_FRAMES)%PREROLL_FRAMES;
  for(int i=0;i<prerollCount;i++){append(preroll[(start+i)%PREROLL_FRAMES]);Arrays.fill(preroll[(start+i)%PREROLL_FRAMES],(short)0);}
  prerollCount=prerollNext=0;
 }

 private void append(short[] frame){
  if(utteranceFrames>=MAX_FRAMES)return;
  int base=utteranceFrames*FRAME_SAMPLES;
  for(int i=0;i<FRAME_SAMPLES;i++)utterance[base+i]=frame[i]/32768f;
  utteranceFrames++;
 }

 private void close(){
  int frames=utteranceFrames-Math.min(silenceRun,utteranceFrames-1);
  boolean keep=speechFrames>=MIN_SPEECH_FRAMES;
  float[] out=keep?Arrays.copyOf(utterance,frames*FRAME_SAMPLES):null;
  Arrays.fill(utterance,0,utteranceFrames*FRAME_SAMPLES,0f);
  active=false;utteranceFrames=speechFrames=silenceRun=speechRun=0;
  if(out!=null)sink.onUtterance(out);
 }
}
