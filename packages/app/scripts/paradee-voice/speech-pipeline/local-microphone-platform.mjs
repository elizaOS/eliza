/** JVM ports for the real local recording and live microphone owners. No audio APIs are invoked. */
export const microphonePlatform = {
  "android/content/Context.java": `package android.content;
public class Context {
  private final java.io.File cache;
  public Context(java.io.File cache) { this.cache=cache; }
  public java.io.File getCacheDir() { return cache; }
  public int checkSelfPermission(String permission) { return 0; }
}`,
  "android/os/Looper.java": `package android.os;
public class Looper { public static Looper getMainLooper() { return new Looper(); } }`,
  "android/os/Handler.java": `package android.os;
public class Handler {
  public Handler(Looper looper) {}
  public boolean postDelayed(Runnable task,long delay) { return true; }
  public void removeCallbacks(Runnable task) {}
}`,
  "android/os/SystemClock.java": `package android.os;
public class SystemClock { public static long elapsedRealtime() { return 1000; } }`,
  "android/media/AudioTimestamp.java":
    "package android.media; public class AudioTimestamp {}",
  "android/media/audiofx/AcousticEchoCanceler.java": `package android.media.audiofx;
public class AcousticEchoCanceler { public static boolean isAvailable() { return false; } }`,
  "android/media/AudioRecord.java": `package android.media;
public class AudioRecord {
  public static int releases;
  public static boolean failStart,failRelease;
  public AudioRecord(int source,int rate,int channels,int encoding,int bytes) {}
  public static int getMinBufferSize(int rate,int channels,int encoding) { return 6400; }
  public int getState() { return 1; }
  public void startRecording() {
    if(failStart) throw new IllegalStateException("synthetic open failure");
  }
  public void stop() {}
  public void release() {
    if(failRelease) throw new IllegalStateException("synthetic release failure");
    releases++;
  }
}`,
  "android/media/MediaRecorder.java": `package android.media;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;

public class MediaRecorder {
  public static int opens,active;
  public static boolean failPrepare,failRelease,stopError;
  private boolean started;
  private Path output;
  public MediaRecorder() { opens++; }
  public void setAudioSource(int value) {}
  public void setOutputFormat(int value) {}
  public void setAudioEncoder(int value) {}
  public void setAudioChannels(int value) {}
  public void setAudioSamplingRate(int value) {}
  public void setAudioEncodingBitRate(int value) {}
  public void setOutputFile(String path) { output=Path.of(path); }
  public void setMaxDuration(int value) {}
  public void setMaxFileSize(long value) {}
  public interface OnInfoListener { void onInfo(MediaRecorder recorder,int what,int extra); }
  public interface OnErrorListener { void onError(MediaRecorder recorder,int what,int extra); }
  public void setOnInfoListener(OnInfoListener listener) {}
  public void setOnErrorListener(OnErrorListener listener) {}
  public void prepare() throws IOException { if(failPrepare) throw new IOException("synthetic prepare failure"); }
  public void start() {
    try { Files.write(output,new byte[]{1,2,3}); }
    catch(IOException failure) { throw new UncheckedIOException(failure); }
    started=true;
    active++;
  }
  public void stop() { if(stopError) throw new AssertionError("synthetic stop error"); }
  public void release() {
    if(failRelease) throw new IllegalStateException("synthetic release failure");
    if(started) { started=false; active--; }
  }
  public int getMaxAmplitude() { return 0; }
}`,
};
