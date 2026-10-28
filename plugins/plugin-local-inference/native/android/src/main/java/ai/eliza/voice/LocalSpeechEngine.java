package ai.eliza.voice;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.function.BooleanSupplier;

/**
 * Serial ownership of one lazily created speech backend (for example {@link SessionSpeech} over
 * the process-wide {@link InferenceSession}). {@link #use} runs on the host's speech worker;
 * {@link #cancel} never waits behind an active native call. {@link #release} drops the backend
 * (an idle or memory-pressure release); the next use creates it again. {@link #close} is terminal.
 */
public final class LocalSpeechEngine implements AutoCloseable {
 public interface Backend extends AutoCloseable {
  String transcribe(float[] samples) throws Exception;
  Audio synthesize(String text, BooleanSupplier cancelled) throws Exception;
  void cancel();
  void close();
  /** Explicit readiness checks must initialize their native models before reporting ready. */
  default void prepare()throws Exception{}
  /** Native streaming synthesis is available; otherwise speech is synthesized whole. */
  default boolean supportsStreaming(){return false;}
  /** Whether this backend has loaded speech output; lazy session probes do not load it. */
  default boolean speechLoaded(){return true;}
  /**
   * Streams validated mono PCM at {@link #STREAM_RATE} to {@code sink} as the model produces it. Each
   * chunk is finite and bounded; the last call has complete=true. Throws CancellationException when
   * cancelled (by the sink or {@link #cancel}) and IllegalStateException for invalid or silent output.
   */
  default void synthesizeStream(String text,BooleanSupplier cancelled,ChunkSink sink)throws Exception{throw new UnsupportedOperationException("Streaming speech unavailable");}
  default byte[] synthesizePassage(String text, BooleanSupplier cancelled) throws Exception {
   Audio audio=synthesize(text,cancelled);
   try { if(cancelled.getAsBoolean())throw new java.util.concurrent.CancellationException();return audio.wav(); }
   finally { Arrays.fill(audio.samples,0); }
  }
 }
 public static final int STREAM_RATE=24000;
 /** Chunks of one streamed utterance; return false to cancel. May throw: the backend surfaces it. */
 public interface ChunkSink { boolean accept(float[] samples,boolean complete)throws Exception; }
 public interface Factory { Backend create() throws Exception; }
 public interface Operation<T> { T run(Backend backend) throws Exception; }
 private final Factory factory;
 private volatile Backend backend;
 private boolean closed;
 private volatile int loads;
 public LocalSpeechEngine(Factory factory){this.factory=factory;}
 public synchronized <T>T use(Operation<T> operation)throws Exception{
  if(closed)throw new IllegalStateException("Speech engine closed");
  if(backend==null){backend=factory.create();loads++;}
  return operation.run(backend);
 }
 /** Speech load generation; a lazy backend does not advance it until output is loaded. */
 public int loads(){Backend active=backend;return loads-(active!=null&&!active.speechLoaded()?1:0);}
 public void cancel(){Backend active=backend;if(active!=null)active.cancel();}
 public synchronized void release(){Backend previous=backend;backend=null;if(previous!=null)previous.close();}
 @Override public synchronized void close(){if(closed)return;closed=true;release();}
 public static final class Audio {
  public final float[] samples;public final int sampleRate;
  public Audio(float[] samples,int sampleRate){this.samples=samples;this.sampleRate=sampleRate;}
  public byte[] wav(){
   if(sampleRate<8000||sampleRate>48000||samples==null||samples.length==0||samples.length>(8*1024*1024-44)/2)throw new IllegalStateException("Generated audio exceeds playback bound");
   ByteBuffer out=ByteBuffer.allocate(44+samples.length*2).order(ByteOrder.LITTLE_ENDIAN);
   out.putInt(0x46464952).putInt(36+samples.length*2).putInt(0x45564157).putInt(0x20746d66).putInt(16).putShort((short)1).putShort((short)1).putInt(sampleRate).putInt(sampleRate*2).putShort((short)2).putShort((short)16).putInt(0x61746164).putInt(samples.length*2);
   for(float sample:samples){if(!Float.isFinite(sample))throw new IllegalStateException("Invalid generated audio");out.putShort((short)Math.round(Math.max(-1,Math.min(1,sample))*32767));}
   return out.array();
  }
 }
 /** Decode complete mono PCM16 WAV; metadata chunks never become audio. */
 public static float[] readMono16kWav(java.io.InputStream input)throws IOException{
  java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[8192];try{int count;while((count=input.read(buffer))!=-1){if(out.size()+count>44+16000*60*2+4096)throw new IOException("Audio exceeds bound");out.write(buffer,0,count);}byte[] bytes=out.toByteArray();try{return readMono16kWav(bytes);}finally{Arrays.fill(bytes,(byte)0);}}finally{Arrays.fill(buffer,(byte)0);}
 }
 public static float[] readMono16kWav(byte[] bytes)throws IOException{
  if(bytes.length<44||bytes.length>44+16000*60*2+4096)throw new IOException("Invalid audio size");
  ByteBuffer b=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
  if(b.getInt()!=0x46464952||b.getInt()!=bytes.length-8||b.getInt()!=0x45564157)throw new IOException("Expected complete RIFF WAV");
  boolean format=false;
  while(b.remaining()>=8){int kind=b.getInt(),size=b.getInt();if(size<0||size>b.remaining())throw new IOException("Incomplete WAV chunk");int end=b.position()+size;
   if(kind==0x20746d66){if(size<16||b.getShort()!=1||b.getShort()!=1||b.getInt()!=16000||b.getInt()!=32000||b.getShort()!=2||b.getShort()!=16)throw new IOException("Expected mono 16k PCM16");format=true;}
   if(kind==0x61746164){if(!format||size%2!=0||size>16000*60*2)throw new IOException("Invalid PCM data");float[] samples=new float[size/2];for(int i=0;i<samples.length;i++)samples[i]=b.getShort()/32768f;return samples;}
   if(end+(size%2)>bytes.length)throw new IOException("Missing WAV padding");b.position(end+(size%2));
  }
  throw new IOException("No PCM data");
 }
}
