// spec/os/voice/speechOutput.md, "Story: Start a reply's audio promptly without playing over anything"; spec/os/voice/speechOutput.md, "Story: Prime the audio output without playing over anything"
package ai.eliza.voice;

import android.media.AudioFormat;
import android.media.AudioTimestamp;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Process;

public final class AudioTrackSpeechOutput implements StreamingSpeechPlayback.Output {
  public static final int BUFFER_MS = 200;
  public static final int START_MS = 40;

  private final AudioTrack track;
  private final AudioTimestamp stamp = new AudioTimestamp();
  private final int rate;

  private AudioTrackSpeechOutput(AudioTrack track, int rate) {
    this.track = track;
    this.rate = rate;
  }

  public static SpeechOutputWarmup warmup(int rate) {
    return new SpeechOutputWarmup(rate, SpeechOutputWarmup.LIMIT_NS, () -> open(rate), System::nanoTime);
  }

  public static AudioTrackSpeechOutput open(int rate) {
    try {
      Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
    } catch (RuntimeException defaultPriority) {
    }
    int minimum = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT);
    if (minimum <= 0) throw new IllegalStateException("Float speech output unsupported");
    int bytes = Math.max(minimum, rate * 4 * BUFFER_MS / 1000);
    AudioTrack track = new AudioTrack.Builder()
        .setAudioAttributes(SpeechAudioFocus.ATTRIBUTES)
        .setAudioFormat(new AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
            .setSampleRate(rate)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build())
        .setTransferMode(AudioTrack.MODE_STREAM)
        .setBufferSizeInBytes(bytes)
        .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
        .build();
    if (track.getState() != AudioTrack.STATE_INITIALIZED) {
      track.release();
      throw new IllegalStateException("Speech output unavailable");
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try {
        track.setStartThresholdInFrames(Math.max(1, rate * START_MS / 1000));
      } catch (RuntimeException wholeBuffer) {
      }
    }
    return new AudioTrackSpeechOutput(track, rate);
  }

  @Override
  public void play() {
    track.play();
  }

  @Override
  public int write(float[] samples, int offset, int length) {
    for (int i = offset; i < offset + length; i++) {
      if (samples[i] > 1f) samples[i] = 1f;
      else if (samples[i] < -1f) samples[i] = -1f;
    }
    return track.write(samples, offset, length, AudioTrack.WRITE_BLOCKING);
  }

  @Override
  public long playedFrames() {
    return track.getPlaybackHeadPosition() & 0xffffffffL;
  }

  @Override
  public long presentationNs(long frame) {
    try {
      if (!track.getTimestamp(stamp) || stamp.nanoTime <= 0 || stamp.framePosition <= 0) return StreamingSpeechPlayback.UNSET;
      return stamp.nanoTime + (frame - stamp.framePosition) * 1_000_000_000L / rate;
    } catch (RuntimeException unavailable) {
      return StreamingSpeechPlayback.UNSET;
    }
  }

  @Override
  public int startThresholdFrames() {
    try {
      return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? track.getStartThresholdInFrames() : track.getBufferSizeInFrames();
    } catch (RuntimeException unavailable) {
      return 0;
    }
  }

  @Override
  public void setVolume(float volume) {
    try {
      track.setVolume(volume);
    } catch (RuntimeException released) {
    }
  }

  @Override
  public void abort() {
    try {
      track.pause();
      track.flush();
    } catch (RuntimeException stopped) {
    }
  }

  @Override
  public void stop() {
    try {
      track.stop();
    } catch (RuntimeException stopped) {
    }
  }

  @Override
  public void release() {
    track.release();
  }
}
