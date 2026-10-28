package ai.eliza.voice;

/** Host-JVM check of the live capture source policy. Not Android, microphone or echo evidence. */
public final class LiveCaptureSourceTest {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args){
  final int recognition=6,communication=7; // MediaRecorder.AudioSource values
  check(LiveCaptureSource.select(true,true,recognition,communication)==communication,"the assistant uses the echo-cancelled source when a canceller exists");
  check(LiveCaptureSource.select(true,false,recognition,communication)==recognition,"no canceller: keep the recognition source");
  check(LiveCaptureSource.select(false,true,recognition,communication)==recognition,"dictation keeps the recognition source");
  check(LiveCaptureSource.select(false,false,recognition,communication)==recognition,"dictation keeps the recognition source");
  System.out.println("PASS live capture source");
 }
}
