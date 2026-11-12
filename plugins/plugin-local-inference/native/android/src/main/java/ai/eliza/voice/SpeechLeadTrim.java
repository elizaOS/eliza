package ai.eliza.voice;

import java.util.Arrays;

/**
 * Drops the near-silence that opens a synthesized utterance (about 300 ms for Paradee), keeping a short
 * pre-roll so a soft onset is not clipped. Later samples pass through untouched.
 */
public final class SpeechLeadTrim {
 private final float level;
 private final int preRoll;
 private float[] held=new float[0];
 private boolean open;
 public SpeechLeadTrim(float level,int preRollSamples){this.level=level;preRoll=preRollSamples;}
 /** The samples to play from this chunk; empty while the utterance is still silent. Takes ownership. */
 public float[] next(float[] samples){
  if(open)return samples;
  int first=-1;
  for(int i=0;i<samples.length;i++)if(Math.abs(samples[i])>=level){first=i;break;}
  if(first<0){
   int keep=Math.min(preRoll,held.length+samples.length),fromHeld=Math.max(0,keep-samples.length);
   float[] tail=new float[keep];
   System.arraycopy(held,held.length-fromHeld,tail,0,fromHeld);
   System.arraycopy(samples,samples.length-(keep-fromHeld),tail,fromHeld,keep-fromHeld);
   Arrays.fill(samples,0f);held=tail;
   return new float[0];
  }
  open=true;
  int from=Math.max(0,first-preRoll),lead=Math.min(held.length,preRoll-(first-from));
  float[] out=new float[lead+samples.length-from];
  System.arraycopy(held,held.length-lead,out,0,lead);
  System.arraycopy(samples,from,out,lead,samples.length-from);
  Arrays.fill(samples,0f);held=new float[0];
  return out;
 }
}
