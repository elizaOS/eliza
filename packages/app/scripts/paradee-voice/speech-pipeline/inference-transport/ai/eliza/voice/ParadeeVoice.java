package ai.eliza.voice;
public final class ParadeeVoice {
 public static final class Audio {
  public final float[] samples;public final int sampleRate;
  Audio(float[] samples,int sampleRate){this.samples=samples;this.sampleRate=sampleRate;}
  public double seconds(){return samples.length/(double)sampleRate;}
 }
}
