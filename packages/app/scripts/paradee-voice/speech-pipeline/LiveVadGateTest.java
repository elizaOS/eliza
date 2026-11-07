package ai.eliza.voice;

/** Host-JVM check of the live voice VAD gate. Not Android, microphone or model evidence. */
public final class LiveVadGateTest {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args){
  LiveVadGate gate=new LiveVadGate();
  check(gate.accept(0.9f)==LiveVadGate.Edge.NONE,"one loud window is not speech");
  check(gate.accept(0.1f)==LiveVadGate.Edge.NONE&&!gate.speaking(),"a blip resets the start run");
  check(gate.accept(0.6f)==LiveVadGate.Edge.NONE&&gate.accept(0.7f)==LiveVadGate.Edge.SPEECH_START&&gate.speaking(),"two windows at P>=0.5 open a segment");
  for(int i=0;i<LiveVadGate.END_WINDOWS-1;i++)check(gate.accept(0.1f)==LiveVadGate.Edge.NONE,"short pauses stay inside the segment");
  check(gate.accept(0.4f)==LiveVadGate.Edge.NONE,"a window at or above the end threshold restarts the silence run");
  for(int i=0;i<LiveVadGate.END_WINDOWS-1;i++)check(gate.accept(0.2f)==LiveVadGate.Edge.NONE,"still inside");
  check(gate.accept(0.2f)==LiveVadGate.Edge.SPEECH_END&&!gate.speaking(),"16 quiet windows (about 512 ms) close it");
  check(gate.accept(Float.NaN)==LiveVadGate.Edge.NONE,"a non-finite probability is silence");
  gate.accept(0.9f);gate.accept(0.9f);check(gate.close()&&!gate.speaking()&&!gate.close(),"close ends an open segment once");
  check(LiveVadGate.WINDOW==512&&LiveVadGate.PREROLL_WINDOWS*32==320,"512-sample windows and a 320 ms pre-roll");
  System.out.println("PASS live vad gate");
 }
}
