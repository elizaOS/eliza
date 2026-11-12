package ai.eliza.voice;

/** JVM contract for the conversation's hold on the speech engine. */
public final class SpeechEngineHoldTest {
 private static void check(boolean ok,String what){if(!ok)throw new AssertionError(what);}
 public static void main(String[] args){
  SpeechEngineHold hold=new SpeechEngineHold();
  check(!hold.keeps(true)&&!hold.release(),"nothing is held at first, and releasing nothing reports nothing");
  hold.hold();hold.hold();
  check(hold.keeps(true),"a hold in the foreground keeps the engine past the idle timer");
  check(!hold.keeps(false),"a hold never keeps the engine in the background");
  check(hold.release()&&!hold.release(),"two holds are one: the first release ends it");
  check(!hold.keeps(true),"a released hold keeps nothing");
  System.out.println("PASS speech engine hold");
 }
}
