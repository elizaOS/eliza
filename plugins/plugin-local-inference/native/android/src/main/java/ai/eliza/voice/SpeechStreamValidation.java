package ai.eliza.voice;

/** Bounds, finiteness and the whole-utterance energy check of streamed speech output. Pure Java. */
final class SpeechStreamValidation {
 static final int MAX_SAMPLES=(8*1024*1024-44)/2;
 long samples;double energy;boolean complete,cancelled;Throwable failure;
 void accept(float[] chunk,boolean last){
  if(complete)throw new IllegalStateException("Speech chunk after completion");
  if(chunk==null||chunk.length>24000)throw new IllegalStateException("Invalid speech output");
  if(samples+chunk.length>MAX_SAMPLES)throw new IllegalStateException("Generated audio exceeds playback bound");
  for(float sample:chunk){if(!Float.isFinite(sample))throw new IllegalStateException("Invalid speech output");energy+=(double)sample*sample;}
  samples+=chunk.length;
  if(last){
   if(samples<2400)throw new IllegalStateException("Invalid speech output");
   if(energy/samples<0.000001)throw new IllegalStateException("Speech output is silent");
   complete=true;
  }
 }
}
