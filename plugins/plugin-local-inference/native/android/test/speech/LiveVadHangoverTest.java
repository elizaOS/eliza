package ai.eliza.voice;

/** JVM contract for the configurable VAD start run, end hangover and barge-in run; no Android classes are involved. */
public final class LiveVadHangoverTest {
 private static void check(boolean ok,String what){if(!ok)throw new AssertionError(what);}
 public static void main(String[] args){
  LiveCaptureOptions plain=LiveCaptureOptions.of(true);
  check(plain.startWindows==LiveVadGate.START_WINDOWS&&plain.endWindows==LiveVadGate.END_WINDOWS&&!plain.bargeIn,"no option keeps the 64 ms start and 512 ms hangover");
  LiveCaptureOptions quick=LiveCaptureOptions.of(true,null,160,true,null);
  check(quick.endWindows==5&&quick.endHangoverMs()==160&&quick.startWindows==2,"160 ms is five windows");
  check(quick.bargeIn&&quick.bargeInWindows==9&&quick.bargeInMs()==288,"300 ms of speech rounds to nine windows");
  check(LiveCaptureOptions.of(false,null,170,false,null).endWindows==5&&LiveCaptureOptions.of(false,null,180,false,null).endWindows==6,"a hangover rounds to the nearest window");
  check(LiveCaptureOptions.of(false,1,10,false,1).endHangoverMs()==96&&LiveCaptureOptions.of(false,9000,9000,false,9000).endHangoverMs()==1024,"the hangover is clamped to 96..1024 ms");
  check(LiveCaptureOptions.of(false,1,null,false,null).startWindows==1&&LiveCaptureOptions.of(false,9000,null,false,null).startWindows==8,"the start run is clamped inside the pre-roll");
  check(LiveCaptureOptions.of(false,null,null,true,1).bargeInWindows==2,"the barge-in run has a floor");

  LiveVadGate gate=new LiveVadGate(quick.startWindows,quick.endWindows);
  check(gate.accept(0.9f)==LiveVadGate.Edge.NONE&&gate.accept(0.9f)==LiveVadGate.Edge.SPEECH_START,"two windows open a segment");
  for(int i=0;i<4;i++)check(gate.accept(0.1f)==LiveVadGate.Edge.NONE,"four quiet windows stay inside");
  check(gate.accept(0.4f)==LiveVadGate.Edge.NONE,"a window at the end threshold restarts the hangover");
  for(int i=0;i<4;i++)check(gate.accept(0.1f)==LiveVadGate.Edge.NONE,"still inside");
  check(gate.accept(0.1f)==LiveVadGate.Edge.SPEECH_END&&!gate.speaking(),"the fifth quiet window (160 ms) closes it");

  LiveVadGate slow=new LiveVadGate(4,3);
  for(int i=0;i<3;i++)check(slow.accept(0.8f)==LiveVadGate.Edge.NONE,"three windows are not a four-window start");
  check(slow.accept(0.8f)==LiveVadGate.Edge.SPEECH_START,"the fourth opens it");

  // The barge-in run counts windows at the start threshold, inside or outside a segment.
  LiveVadGate run=new LiveVadGate();
  for(int i=1;i<=9;i++){run.accept(0.7f);check(run.speechRun()==i,"run "+i);}
  run.accept(0.4f);
  check(run.speechRun()==0&&run.speaking(),"a window below the start threshold restarts the run, not the segment");
  run.accept(0.6f);check(run.speechRun()==1,"the run starts again");
  run.close();check(run.speechRun()==0,"close clears the run");
  boolean refused=false;try{new LiveVadGate(LiveVadGate.PREROLL_WINDOWS+1,16);}catch(IllegalArgumentException expected){refused=true;}
  check(refused,"a start run longer than the pre-roll would lose the opening syllable");
  System.out.println("PASS live vad hangover");
 }
}
