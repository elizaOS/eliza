package ai.eliza.voice;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CancellationException;

/**
 * Host-JVM contract of the validated speech backend over the shared session (stub natives):
 * bounded input, silent input, finite non-silent output, per-chunk stream validation with zeroing,
 * cancellation, and client-scoped cancel and release over a shared session. Not model or device
 * evidence.
 */
public final class SessionSpeechContract {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static float[] tone(int length,float level){float[] out=new float[length];Arrays.fill(out,level);return out;}
 static boolean zero(float[] samples){for(float sample:samples)if(sample!=0f)return false;return true;}
 static void rejects(Class<? extends Throwable> type,ThrowingRunnable action,String message){
  try{action.run();throw new AssertionError(message);}catch(Throwable error){if(!type.isInstance(error))throw new AssertionError(message+": "+error,error);}
 }
 interface ThrowingRunnable{void run()throws Exception;}
 public static void main(String[] args)throws Exception{
  File root=java.nio.file.Files.createTempDirectory("session-speech-").toFile();
  File model=new File(root,"model.gguf"),lexicon=new File(root,"lexicon.lex");
  File asr=new File(root,"asr");
  check(asr.mkdir()&&model.createNewFile()&&lexicon.createNewFile(),"bundle files");
  InferenceSession session=new InferenceSession(root,model,lexicon,null);
  SessionSpeech speech=new SessionSpeech(session,false);
  try{
   // Recognition input bounds and silence.
   rejects(IllegalArgumentException.class,()->speech.transcribe(new float[100]),"under 0.1 s refused");
   rejects(IllegalArgumentException.class,()->speech.transcribe(new float[16000*60+1]),"over 60 s refused");
   float[] invalid=tone(1600,.2f);invalid[3]=Float.NaN;
   rejects(IllegalArgumentException.class,()->speech.transcribe(invalid),"non-finite PCM refused");
   check("".equals(speech.transcribe(new float[1600])),"silent input transcribes to nothing without the model");
   VoiceNative.heard="  hello there ";
   check("hello there".equals(speech.transcribe(tone(1600,.2f))),"transcript is trimmed");
   VoiceNative.heard=null;
   rejects(IllegalStateException.class,()->speech.transcribe(tone(1600,.2f)),"a missing transcript fails");
   VoiceNative.heard="transcript";
   // Whole-utterance synthesis output validation.
   rejects(IllegalArgumentException.class,()->speech.synthesize(" "),"blank text refused");
   rejects(IllegalArgumentException.class,()->speech.synthesize("a\0b"),"NUL text refused");
   VoiceNative.synthesized=tone(4800,.3f);
   LocalSpeechEngine.Audio audio=speech.synthesize("hello");
   check(audio.sampleRate==24000&&audio.samples.length==4800,"valid output accepted");
   VoiceNative.synthesized=tone(100,.3f);
   rejects(IllegalStateException.class,()->speech.synthesize("short"),"under 0.1 s of output refused");
   VoiceNative.synthesized=tone(4800,0f);
   rejects(IllegalStateException.class,()->speech.synthesize("silent"),"silent output refused");
   float[] nan=tone(4800,.3f);nan[10]=Float.NaN;VoiceNative.synthesized=nan;
   rejects(IllegalStateException.class,()->speech.synthesize("nan"),"non-finite output refused");
   VoiceNative.synthesized=tone(4800,.3f);
   rejects(CancellationException.class,()->speech.synthesize("cancelled",()->true),"cancelled before synthesis");
   // Streamed synthesis: validated chunks reach the sink; a rejected chunk is zeroed and rethrown after return.
   VoiceNative.streamed=new float[][]{tone(2400,.3f),tone(2400,.3f)};
   List<float[]> received=new ArrayList<>();
   speech.synthesizeStream("stream",()->false,(samples,complete)->{received.add(samples);return true;});
   check(received.size()==3&&received.get(2).length==0,"two chunks and the completion reached the sink");
   VoiceNative.streamed=new float[][]{tone(2400,.3f),{Float.NaN}};
   List<float[]> partial=new ArrayList<>();
   rejects(IllegalStateException.class,()->speech.synthesizeStream("bad",()->false,(samples,complete)->{partial.add(samples);return true;}),"a non-finite chunk fails the stream");
   check(partial.size()==1,"the invalid chunk never reaches the sink");
   VoiceNative.streamed=new float[][]{tone(4800,0f)};
   rejects(IllegalStateException.class,()->speech.synthesizeStream("silent",()->false,(samples,complete)->true),"a silent stream fails at completion");
   VoiceNative.streamed=new float[][]{tone(2400,.3f),tone(2400,.3f)};
   RuntimeException sinkFailure=new RuntimeException("sink");
   try{speech.synthesizeStream("sink",()->false,(samples,complete)->{throw sinkFailure;});throw new AssertionError("sink failure surfaced");}catch(RuntimeException error){check(error==sinkFailure,"the sink's own failure is rethrown after the native call");}
   rejects(CancellationException.class,()->speech.synthesizeStream("refused",()->false,(samples,complete)->false),"a refusing sink cancels");
   boolean[] cancelNow={false};
   rejects(CancellationException.class,()->speech.synthesizeStream("cancel",()->cancelNow[0],(samples,complete)->{cancelNow[0]=true;return true;}),"cancellation between chunks");
   VoiceNative.sampleRate=16000;session.trimMemory();
   rejects(IllegalStateException.class,()->speech.synthesizeStream("rate",()->false,(samples,complete)->true),"an unexpected stream rate is refused");
   VoiceNative.sampleRate=24000;session.trimMemory();
   VoiceNative.streamed=null;
   // A shared backend releases its hold instead of closing; as the last holder it frees the models.
   speech.close();
   check(!session.isClosed()&&!session.isSpeechLoaded(),"the last shared backend's close frees the models");
   VoiceNative.synthesized=tone(4800,.3f);
   check(speech.synthesize("again").samples.length==4800,"the released session reloads");
   // Two backends over one session are separate clients: one's release keeps the other's models,
   // and one's cancel never fences the other's call; its own cancel does.
   SessionSpeech other=new SessionSpeech(session,false);
   check(other.synthesize("other").samples.length==4800,"a second backend shares the loaded models");
   speech.close();
   check(session.isSpeechLoaded(),"one backend's release keeps another holder's models");
   other.close();
   check(!session.isSpeechLoaded(),"the last holder's release frees the models");
   VoiceNative.afterTtsLoad=speech::cancel;
   check(other.synthesize("unfenced").samples.length==4800,"another backend's cancel never fences this call");
   VoiceNative.afterTtsLoad=other::cancel;
   other.close();
   rejects(CancellationException.class,()->other.synthesize("fenced"),"a backend's own cancel fences its call");
   VoiceNative.afterTtsLoad=null;
   other.close();
   SessionSpeech owned=new SessionSpeech(new InferenceSession(root,model,lexicon,null),true);
   InferenceSession ownedSession=owned.session();
   owned.close();
   check(ownedSession.isClosed(),"owned backend close is terminal");
   System.out.println("PASS session speech validation");
  }finally{VoiceNative.afterTtsLoad=null;session.close();model.delete();lexicon.delete();asr.delete();root.delete();VoiceNative.synthesized=new float[]{1};VoiceNative.streamed=null;VoiceNative.heard="transcript";}
 }
}
