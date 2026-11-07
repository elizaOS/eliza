package ai.eliza.voice;

/**
 * Microphone source policy for live capture. Pure: the host JVM test evaluates it directly.
 *
 * <p>The voice assistant listens while its reply plays so the user can interrupt it. That needs
 * the communication source, which carries the platform acoustic echo canceller, whenever the device
 * reports one. Without a canceller, or for dictation (nothing plays), the unprocessed recognition
 * source is kept: it gives the recognizer the cleanest signal. Echo that remains is a device
 * acceptance item, not something this policy claims to remove.
 */
public final class LiveCaptureSource {
 private LiveCaptureSource(){}
 public static int select(boolean echoCancel,boolean cancellerAvailable,int recognition,int communication){
  return echoCancel&&cancellerAvailable?communication:recognition;
 }
}
