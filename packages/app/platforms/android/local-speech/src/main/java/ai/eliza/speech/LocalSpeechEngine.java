package ai.eliza.speech;

import android.content.res.AssetManager;
import com.k2fsa.sherpa.onnx.*;
import java.io.*;
import java.nio.*;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;

/** MIT: generic in-process CPU speech, independent of accounts, HTTP, and product UI.
 * The owning worker must serialize usage. Only a hash-verified immutable model bundle
 * is accepted; no network, download, model discovery, or remote fallback occurs here. */
public final class LocalSpeechEngine implements AutoCloseable {
 private OfflineRecognizer recognizer;
 private OfflineTts speaker;
 private boolean closed;
 private final Set<String> words=new HashSet<>();
 public LocalSpeechEngine(File directory)throws Exception {
  JSONObject manifest=new JSONObject(readText(new File(directory,"manifest.json"),65536));
  if(!"eliza-local-speech-v1".equals(manifest.getString("format")))throw new IOException("Unsupported model bundle");
  JSONArray files=manifest.getJSONArray("files");Set<String> approved=new HashSet<>();
  for(int i=0;i<files.length();i++){
   JSONObject item=files.getJSONObject(i);String name=item.getString("path");
   if(name.startsWith("/")||name.contains("..")||!approved.add(name))throw new IOException("Invalid model manifest path");
   File file=new File(directory,name);if(!file.getCanonicalPath().startsWith(directory.getCanonicalPath()+File.separator)||file.length()!=item.getLong("bytes"))throw new IOException("Model size mismatch");
   MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)digest.update(b,0,n);}
   if(!hex(digest.digest()).equals(item.getString("sha256")))throw new IOException("Model checksum mismatch");
  }
  String[] required={"asr/encoder.onnx","asr/decoder.onnx","asr/tokens.txt","tts/model.onnx","tts/lexicon.txt","tts/tokens.txt"};for(String name:required)if(!approved.contains(name))throw new IOException("Missing required model file");
  try(BufferedReader reader=new BufferedReader(new InputStreamReader(new FileInputStream(new File(directory,"tts/lexicon.txt")),java.nio.charset.StandardCharsets.UTF_8))){String line;while((line=reader.readLine())!=null){int split=line.indexOf(' ');if(split>0)words.add(line.substring(0,split));}}
  String tokenMap=readText(new File(directory,"tts/tokens.txt"),65536);for(String expected:new String[]{"_ 0","^ 1","$ 2"})if(!Arrays.asList(tokenMap.split("\\r?\\n")).contains(expected))throw new IOException("Unsupported Piper token convention");
  OfflineWhisperModelConfig whisper=new OfflineWhisperModelConfig();whisper.setEncoder(path(directory,required[0]));whisper.setDecoder(path(directory,required[1]));whisper.setLanguage("en");whisper.setTask("transcribe");
  OfflineModelConfig model=new OfflineModelConfig();model.setWhisper(whisper);model.setTokens(path(directory,required[2]));model.setProvider("cpu");model.setNumThreads(2);model.setDebug(false);
  OfflineRecognizerConfig config=new OfflineRecognizerConfig();config.setModelConfig(model);
  recognizer=new OfflineRecognizer(null,config);
  try{
   OfflineTtsVitsModelConfig vits=new OfflineTtsVitsModelConfig();vits.setModel(path(directory,required[3]));vits.setLexicon(path(directory,required[4]));vits.setTokens(path(directory,required[5]));vits.setDataDir("");
   OfflineTtsModelConfig voice=new OfflineTtsModelConfig();voice.setVits(vits);voice.setProvider("cpu");voice.setNumThreads(2);voice.setDebug(false);
   OfflineTtsConfig speech=new OfflineTtsConfig();speech.setModel(voice);speech.setMaxNumSentences(1);
   // Only lexicon-based English TTS; no espeak data and no dynamic frontend choice.
   speaker=new OfflineTts(null,speech);
  }catch(Exception|Error error){recognizer.release();recognizer=null;throw error;}
 }
 private static String hex(byte[] bytes){StringBuilder out=new StringBuilder();for(byte value:bytes)out.append(String.format(Locale.ROOT,"%02x",value&255));return out.toString();}
 private static String path(File root,String relative){return new File(root,relative).getAbsolutePath();}
 private static byte[] readBounded(InputStream in,int limit)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] block=new byte[8192];int n;while((n=in.read(block,0,Math.min(block.length,limit-out.size())))>0)out.write(block,0,n);return out.toByteArray();}
 private static String readText(File file,int limit)throws IOException{if(file.length()>limit)throw new IOException("Manifest too large");try(InputStream in=new FileInputStream(file)){return new String(readBounded(in,limit),java.nio.charset.StandardCharsets.UTF_8);}}
 public synchronized String transcribe(float[] mono16k){
  check();if(mono16k==null||mono16k.length<1600||mono16k.length>16000*30)throw new IllegalArgumentException("Expected 0.1 to 30 seconds of mono 16kHz PCM");
  double energy=0;for(float sample:mono16k){if(!Float.isFinite(sample)||Math.abs(sample)>1)throw new IllegalArgumentException("Invalid PCM sample");energy+=(double)sample*sample;}
  if(energy/mono16k.length<0.000001)return ""; // Never hallucinate a note from digital silence.
  OfflineStream stream=recognizer.createStream();try{stream.acceptWaveform(mono16k,16000);recognizer.decode(stream);String result=recognizer.getResult(stream).getText().trim();if(result.length()>16000)throw new IllegalStateException("Transcript exceeds limit");return result;}finally{stream.release();}
 }
 public synchronized Audio synthesize(String text){return synthesizeInternal(text,null);}
 /** Cancellation is cooperative between native sentence batches, not during an ONNX call.
  * The predicate must be thread-safe and nonblocking. Handles remain owned by this worker. */
 public synchronized Audio synthesize(String text,java.util.function.BooleanSupplier cancellation){
  return synthesizeInternal(text,Objects.requireNonNull(cancellation));
 }
 /** Reviewed text never leaves this engine; unsupported trailing chunks fail before synthesis. */
 public synchronized byte[] synthesizePassage(String text,java.util.function.BooleanSupplier cancellation){
  check();return SpeechPassage.synthesize(text,chunk->SpeechText.prepare(chunk,words),chunk->{Audio audio=synthesizeInternal(chunk,cancellation);return new SpeechPassage.Pcm(audio.samples,audio.sampleRate);},cancellation);
 }
 private Audio synthesizeInternal(String text,java.util.function.BooleanSupplier cancellation){
  check();
  if(cancellation!=null&&cancellation.getAsBoolean())throw new java.util.concurrent.CancellationException("Speech cancelled");
  String spoken=SpeechText.prepare(text,words);
  SynthesisCallback callback=cancellation==null?null:new SynthesisCallback(cancellation);
  GeneratedAudio generated=callback==null?speaker.generate(spoken,0,1.0f):speaker.generateWithCallback(spoken,0,1.0f,callback);
  float[] samples=generated.getSamples();int rate=generated.getSampleRate();boolean accepted=false;
  try{
   if(callback!=null&&callback.failure!=null)throw new IllegalStateException("Speech cancellation check failed",callback.failure);
   if((callback!=null&&callback.cancelled)||(cancellation!=null&&cancellation.getAsBoolean()))throw new java.util.concurrent.CancellationException("Speech cancelled");
   if(rate<8000||rate>48000||samples.length<rate/10||samples.length>rate*90)throw new IllegalStateException("Invalid generated audio duration");
   double energy=0;for(float sample:samples){if(!Float.isFinite(sample))throw new IllegalStateException("Invalid generated audio");energy+=(double)sample*sample;}if(energy/samples.length<0.000001)throw new IllegalStateException("Generated audio was silent");
   accepted=true;return new Audio(samples,rate);
  }finally{if(!accepted)Arrays.fill(samples,0);}
 }
 // JNI explicitly looks up invoke([F)Ljava/lang/Integer;, not the erased Function1 method.
 // An explicit implementation supplies that method and javac's invoke(Object) bridge.
 private static final class SynthesisCallback implements kotlin.jvm.functions.Function1<float[],Integer> {
  private final java.util.function.BooleanSupplier cancellation;
  private boolean cancelled;
  private Throwable failure;
  SynthesisCallback(java.util.function.BooleanSupplier cancellation){this.cancellation=cancellation;}
  @Override public Integer invoke(float[] chunk){
   try{cancelled|=cancellation.getAsBoolean();}catch(Throwable error){cancelled=true;failure=error;}
   finally{Arrays.fill(chunk,0);}
   return cancelled?0:1;
  }
 }
 private void check(){if(closed)throw new IllegalStateException("Speech engine closed");}
 @Override public synchronized void close(){if(closed)return;closed=true;if(recognizer!=null)recognizer.release();if(speaker!=null)speaker.release();recognizer=null;speaker=null;}
 public static final class Audio {
  public final float[] samples;public final int sampleRate;
  public Audio(float[] samples,int sampleRate){this.samples=samples;this.sampleRate=sampleRate;}
  public byte[] wav(){ByteBuffer out=ByteBuffer.allocate(44+samples.length*2).order(ByteOrder.LITTLE_ENDIAN);out.put(new byte[]{'R','I','F','F'}).putInt(36+samples.length*2).put(new byte[]{'W','A','V','E','f','m','t',' '}).putInt(16).putShort((short)1).putShort((short)1).putInt(sampleRate).putInt(sampleRate*2).putShort((short)2).putShort((short)16).put(new byte[]{'d','a','t','a'}).putInt(samples.length*2);for(float sample:samples)out.putShort((short)Math.round(Math.max(-1,Math.min(1,sample))*32767));return out.array();}
 }
 public static float[] readMono16kWav(InputStream input)throws IOException {
  byte[] bytes=readBounded(input,44+16000*30*2+4096);if(input.read()!=-1)throw new IOException("Audio fixture too large");ByteBuffer b=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
  if(bytes.length<44||b.getInt()!=0x46464952)throw new IOException("Expected RIFF WAV");b.getInt();if(b.getInt()!=0x45564157)throw new IOException("Expected WAVE");boolean format=false;
  while(b.remaining()>=8){int type=b.getInt(),size=b.getInt();if(size<0||size>b.remaining())throw new IOException("Truncated WAV chunk");int end=b.position()+size;
   if(type==0x20746d66){if(size<16||b.getShort()!=1||b.getShort()!=1||b.getInt()!=16000)throw new IOException("Expected mono 16k PCM");b.getInt();if(b.getShort()!=2||b.getShort()!=16)throw new IOException("Expected PCM16");format=true;}
   if(type==0x61746164){if(!format||size%2!=0||size>16000*30*2)throw new IOException("Invalid WAV data");float[] samples=new float[size/2];for(int i=0;i<samples.length;i++)samples[i]=b.getShort()/32768f;return samples;}
   b.position(end+(size%2));
  }throw new IOException("No PCM data");
 }
}
