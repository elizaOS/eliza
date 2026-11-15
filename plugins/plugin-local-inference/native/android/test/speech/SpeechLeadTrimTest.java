package ai.eliza.voice;

/** JVM contract for the synthesized lead-in trim; no Android classes are involved. */
public final class SpeechLeadTrimTest {
 private static void check(boolean ok,String what){if(!ok)throw new AssertionError(what);}
 private static float[] fill(int n,float v){float[] out=new float[n];java.util.Arrays.fill(out,v);return out;}
 public static void main(String[] args){
  SpeechLeadTrim trim=new SpeechLeadTrim(0.01f,4);
  float[] silent=fill(10,0.001f);
  check(trim.next(silent).length==0,"a silent chunk is held back");
  check(silent[9]==0f,"a consumed chunk is cleared");
  float[] loud=new float[6];loud[3]=0.5f;loud[4]=0.4f;loud[5]=0.3f;
  float[] first=trim.next(loud);
  check(first.length==7,"the pre-roll plus the onset chunk: "+first.length);
  check(first[0]==0.001f&&first[3]==0f&&first[4]==0.5f,"the pre-roll keeps the held tail before the onset");
  float[] later=fill(5,0.002f);
  check(trim.next(later)==later,"after the onset, chunks pass through untouched");
  SpeechLeadTrim immediate=new SpeechLeadTrim(0.01f,4);
  float[] onset=fill(3,0.2f);
  check(immediate.next(onset).length==3,"an utterance that starts loud is not trimmed");
  System.out.println("PASS speech lead trim");
 }
}
