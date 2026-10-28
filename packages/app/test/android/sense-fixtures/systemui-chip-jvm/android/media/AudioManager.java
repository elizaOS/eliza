package android.media;
import android.os.Handler;
import java.util.List;
public class AudioManager {
 public static abstract class AudioRecordingCallback { public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs){} }
 public void registerAudioRecordingCallback(AudioRecordingCallback cb,Handler handler){}
 public List<AudioRecordingConfiguration> getActiveRecordingConfigurations(){return java.util.Collections.emptyList();}
}
