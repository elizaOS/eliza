package ai.eliza.voice;

/**
 * Reports the first sample handed to the track. StreamingSpeechPlayback reports its first frame after
 * the blocking write of a whole chunk returns, by which time a chunk longer than the track buffer is
 * already audible; the collector then refuses the earlier audible time.
 */
public final class FirstWriteSpeechOutput implements StreamingSpeechPlayback.Output {
 private final StreamingSpeechPlayback.Output output;
 private Runnable first;
 public FirstWriteSpeechOutput(StreamingSpeechPlayback.Output output,Runnable first){this.output=output;this.first=first;}
 @Override public void play(){output.play();}
 @Override public int write(float[] samples,int offset,int length){
  Runnable report=first;first=null;
  if(report!=null)report.run();
  return output.write(samples,offset,length);
 }
 @Override public long playedFrames(){return output.playedFrames();}
 @Override public long presentationNs(long frame){return output.presentationNs(frame);}
 @Override public void setVolume(float volume){output.setVolume(volume);}
 @Override public void abort(){output.abort();}
 @Override public void stop(){output.stop();}
 @Override public void release(){output.release();}
}
