// spec/os/voice/speechOutput.md, "Story: Start a reply's audio promptly without playing over anything"
package ai.eliza.voice;

public final class FirstWriteSpeechOutput implements StreamingSpeechPlayback.Output {
  private final StreamingSpeechPlayback.Output output;
  private Runnable first;

  public FirstWriteSpeechOutput(StreamingSpeechPlayback.Output output, Runnable first) {
    this.output = output;
    this.first = first;
  }

  @Override public void play() { output.play(); }

  @Override
  public int write(float[] samples, int offset, int length) {
    Runnable report = first;
    first = null;
    if (report != null) report.run();
    return output.write(samples, offset, length);
  }

  @Override public long playedFrames() { return output.playedFrames(); }
  @Override public long presentationNs(long frame) { return output.presentationNs(frame); }
  @Override public int startThresholdFrames() { return output.startThresholdFrames(); }
  @Override public void setVolume(float volume) { output.setVolume(volume); }
  @Override public void abort() { output.abort(); }
  @Override public void stop() { output.stop(); }
  @Override public void release() { output.release(); }
}
