package ai.eliza.voice;

import android.content.Context;
import java.io.IOException;
import java.util.Arrays;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;

/**
 * Validated speech over an {@link InferenceSession}: bounded input, finite and non-silent output,
 * per-chunk stream validation, and zeroing of rejected audio. Each backend is its own
 * {@link InferenceSession.Client}: {@link #cancel} fences only this backend's calls, and over the
 * process-wide session ({@link #shared}) {@link #close} releases only this backend's hold on the
 * models instead of closing or trimming the session, so VAD detectors and other consumers of the
 * same owner keep working.
 */
public final class SessionSpeech implements LocalSpeechEngine.Backend {
 private final InferenceSession inference;
 private final InferenceSession.Client client;
 private final boolean owned;
 /** A new client of the process-wide session ({@link VoiceAssets#sharedInference}); call on a worker thread. */
 public static SessionSpeech shared(Context context)throws IOException{return new SessionSpeech(VoiceAssets.sharedInference(context),false);}
 /** {@code owned}: close() closes the session; otherwise close() releases only this backend's hold. */
 public SessionSpeech(InferenceSession inference,boolean owned){
  if(inference==null)throw new IllegalArgumentException("Expected an inference session");
  this.inference=inference;this.client=inference.client();this.owned=owned;
 }
 public InferenceSession session(){return inference;}
 @Override public void prepare()throws IOException{client.prepareSpeech();}
 public String transcribe(float[] samples)throws IOException{
  if(samples==null||samples.length<1600||samples.length>16000*60)throw new IllegalArgumentException("Expected 0.1 to 60 seconds of audio");
  double energy=0;for(float sample:samples){if(!Float.isFinite(sample)||Math.abs(sample)>1)throw new IllegalArgumentException("Invalid PCM");energy+=(double)sample*sample;}
  if(energy/samples.length<0.000001)return "";
  String text=client.transcribe(samples);if(text==null||text.length()>16000)throw new IllegalStateException("Invalid transcription");return text.trim();
 }
 public LocalSpeechEngine.Audio synthesize(String text)throws IOException{return synthesize(text,()->false);}
 public LocalSpeechEngine.Audio synthesize(String text,BooleanSupplier cancelled)throws IOException{
  if(text==null||text.isBlank()||text.length()>5000||text.indexOf('\0')>=0)throw new IllegalArgumentException("Invalid reviewed speech text");
  if(cancelled.getAsBoolean())throw new CancellationException();
  ParadeeVoice.Audio audio=client.synthesize(text,1f);boolean accepted=false;
  try{
   if(cancelled.getAsBoolean())throw new CancellationException();
   if(audio.sampleRate!=24000||audio.samples.length<2400||audio.samples.length>(8*1024*1024-44)/2)throw new IllegalStateException("Invalid speech output");
   double energy=0;for(float sample:audio.samples){if(!Float.isFinite(sample))throw new IllegalStateException("Invalid speech output");energy+=(double)sample*sample;}
   if(energy/audio.samples.length<0.000001)throw new IllegalStateException("Speech output is silent");
   accepted=true;return new LocalSpeechEngine.Audio(audio.samples,audio.sampleRate);
  }finally{if(!accepted)Arrays.fill(audio.samples,0);}
 }
 @Override public boolean supportsStreaming(){try{return client.supportsStreaming();}catch(LinkageError|RuntimeException unavailable){return false;}}
 @Override public boolean speechLoaded(){return client.isSpeechLoaded();}
 /**
  * Per-chunk validation of the Paradee stream. The sink never reenters the voice;
  * its exceptions (and validation failures) are held and rethrown after the native call returns, so
  * nothing propagates through JNI and the cancellation that ends the native call never masks them.
  * A rejected chunk is zeroed.
  */
 @Override public void synthesizeStream(String text,BooleanSupplier cancelled,LocalSpeechEngine.ChunkSink sink)throws Exception{
  if(text==null||text.isBlank()||text.length()>5000||text.indexOf('\0')>=0)throw new IllegalArgumentException("Invalid reviewed speech text");
  if(cancelled.getAsBoolean())throw new CancellationException();
  if(client.speechSampleRate()!=LocalSpeechEngine.STREAM_RATE)throw new IllegalStateException("Invalid speech output");
  SpeechStreamValidation state=new SpeechStreamValidation();
  try{
   client.synthesizeStream(text,1f,(samples,complete)->{
    try{
     if(cancelled.getAsBoolean()){state.cancelled=true;zero(samples);return false;}
     state.accept(samples,complete);
     if(!sink.accept(samples,complete)){state.cancelled=true;return false;}
     return true;
    }catch(Exception|Error failure){zero(samples);state.failure=failure;return false;}
   });
  }catch(CancellationException ended){if(state.failure==null)throw ended;}
  if(state.failure instanceof Exception)throw (Exception)state.failure;
  if(state.failure instanceof Error)throw (Error)state.failure;
  if(state.cancelled||cancelled.getAsBoolean())throw new CancellationException();
  if(!state.complete)throw new IllegalStateException("Speech stream ended early");
 }
 private static void zero(float[] samples){if(samples!=null)Arrays.fill(samples,0);}
 /** Fences only this backend's calls; another consumer of the same session keeps running. */
 public void cancel(){client.cancel();}
 public void close(){if(owned)inference.close();else client.release();}
}
