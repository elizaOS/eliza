package ai.eliza.speech;

import java.io.ByteArrayOutputStream;
import java.nio.*;
import java.util.*;
import java.util.function.*;

/** Whole-passage preflight, bounded chunk synthesis, and one owned PCM result. */
public final class SpeechPassage {
 private SpeechPassage(){}
 public static List<String> plan(String text){
  if(text==null||text.isBlank()||text.length()>5000||text.indexOf('\0')>=0)throw new IllegalArgumentException("Expected 1 to 5000 reviewed characters");
  String remaining=text.replaceAll("\\s+"," ").trim();List<String> chunks=new ArrayList<>();
  while(remaining.length()>300){int boundary=remaining.lastIndexOf(' ',300);if(boundary<1)throw new IllegalArgumentException("A word is too long for local reading");chunks.add(remaining.substring(0,boundary));remaining=remaining.substring(boundary+1).trim();}
  if(!remaining.isEmpty())chunks.add(remaining);return Collections.unmodifiableList(chunks);
 }
 public static final class Pcm{public final float[] samples;public final int rate;public Pcm(float[] samples,int rate){this.samples=samples;this.rate=rate;}}
 private static void current(BooleanSupplier cancelled){if(cancelled.getAsBoolean())throw new java.util.concurrent.CancellationException("Reading cancelled");}
 public static byte[] synthesize(String text,Consumer<String> preflight,Function<String,Pcm> synthesize,BooleanSupplier cancelled){
  List<String> chunks=plan(text);for(String chunk:chunks){current(cancelled);preflight.accept(chunk);} // No audio generation before every chunk passes.
  Buffer pcm=new Buffer();int rate=0;
  try{for(String chunk:chunks){current(cancelled);Pcm audio=synthesize.apply(chunk);if(audio==null||audio.samples==null)throw new IllegalStateException("No local audio");
   try{current(cancelled);if(audio.rate<8000||audio.rate>48000||audio.samples.length==0||(rate!=0&&rate!=audio.rate)||pcm.size()+2L*audio.samples.length>32*1024*1024)throw new IllegalStateException("Local passage exceeds audio limits");rate=audio.rate;
    for(float value:audio.samples){if(!Float.isFinite(value))throw new IllegalStateException("Invalid local audio");int sample=Math.round(Math.max(-1,Math.min(1,value))*32767);pcm.write(sample&255);pcm.write((sample>>>8)&255);}
   }finally{Arrays.fill(audio.samples,0);}
  }current(cancelled);return pcm.wav(rate);}finally{pcm.erase();}
 }
 private static final class Buffer extends ByteArrayOutputStream{
  byte[] wav(int rate){ByteBuffer out=ByteBuffer.allocate(44+count).order(ByteOrder.LITTLE_ENDIAN);out.put(new byte[]{'R','I','F','F'}).putInt(36+count).put(new byte[]{'W','A','V','E','f','m','t',' '}).putInt(16).putShort((short)1).putShort((short)1).putInt(rate).putInt(rate*2).putShort((short)2).putShort((short)16).put(new byte[]{'d','a','t','a'}).putInt(count).put(buf,0,count);return out.array();}
  void erase(){Arrays.fill(buf,(byte)0);reset();}
 }
}
