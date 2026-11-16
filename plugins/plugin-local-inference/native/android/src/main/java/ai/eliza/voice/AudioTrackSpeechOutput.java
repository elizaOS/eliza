package ai.eliza.voice;

import android.media.AudioFormat;
import android.media.AudioTimestamp;
import android.media.AudioTrack;
import android.media.PlaybackParams;

/**
 * AudioTrack (MODE_STREAM, mono float PCM, assistant/speech attributes) behind
 * {@link StreamingSpeechPlayback.Output}. Opened on the playback writer thread. Nothing is written
 * to storage; the track's buffer is flushed on abort.
 */
public final class AudioTrackSpeechOutput implements StreamingSpeechPlayback.Output {
 /** Platform buffer target: about 200 ms, never below the device minimum, both scaled up by a faster pace. */
 public static final int BUFFER_MS=200;
 /** Frames written before a stopped track starts playing (API 31+): about 40 ms instead of the whole buffer. */
 public static final int START_MS=40;
 private final AudioTrack track;
 private final AudioTimestamp stamp=new AudioTimestamp();
 private final int presentedRate;

 private AudioTrackSpeechOutput(AudioTrack track,int presentedRate){this.track=track;this.presentedRate=presentedRate;}

 public static AudioTrackSpeechOutput open(int rate){return open(rate,1f);}
 public static AudioTrackSpeechOutput open(int rate,float pace){
  try{android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);}catch(RuntimeException ignored){/* Default priority still plays. */}
  int minimum=AudioTrack.getMinBufferSize(rate,AudioFormat.CHANNEL_OUT_MONO,AudioFormat.ENCODING_PCM_FLOAT);
  if(minimum<=0)throw new IllegalStateException("Float speech output unsupported");
  int bytes=(int)Math.ceil(Math.max(minimum,rate*4*BUFFER_MS/1000)*Math.max(1f,pace)/4)*4;
  AudioTrack track=new AudioTrack.Builder()
   .setAudioAttributes(SpeechAudioFocus.ATTRIBUTES)
   .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
   .setTransferMode(AudioTrack.MODE_STREAM)
   .setBufferSizeInBytes(bytes)
   // A request: the platform grants its fast path only where the device mixer accepts this format.
   .setPerformanceMode(pace==1f?AudioTrack.PERFORMANCE_MODE_LOW_LATENCY:AudioTrack.PERFORMANCE_MODE_NONE)
   .build();
  if(track.getState()!=AudioTrack.STATE_INITIALIZED){track.release();throw new IllegalStateException("Speech output unavailable");}
  float speed=pace;
  if(pace!=1f)try{track.setPlaybackParams(new PlaybackParams().setSpeed(pace).setPitch(1f));}catch(RuntimeException unsupported){speed=1f;/* An output that refuses the pace still speaks at the normal pace. */}
  if(android.os.Build.VERSION.SDK_INT>=31)try{track.setStartThresholdInFrames(Math.max(1,rate*START_MS/1000));}catch(RuntimeException ignored){/* The default threshold (the whole buffer) still plays. */}
  return new AudioTrackSpeechOutput(track,Math.round(rate*speed));
 }
 public void play(){track.play();}
 public int write(float[] samples,int offset,int length){
  // Model output can overshoot full scale slightly; clamp in place (the chunk is zeroed after use).
  for(int i=offset;i<offset+length;i++){float sample=samples[i];if(sample>1f)samples[i]=1f;else if(sample<-1f)samples[i]=-1f;}
  return track.write(samples,offset,length,AudioTrack.WRITE_BLOCKING);
 }
 public long playedFrames(){return track.getPlaybackHeadPosition()&0xffffffffL;}
 /** From AudioTrack.getTimestamp (CLOCK_MONOTONIC) once a frame has actually been presented. */
 public long presentationNs(long frame){
  try{
   if(!track.getTimestamp(stamp)||stamp.nanoTime<=0||stamp.framePosition<=0)return VoiceLatencyTrials.UNSET;
   return VoiceLatencyTrials.frameTimeNs(stamp.nanoTime,stamp.framePosition,frame,presentedRate);
  }catch(RuntimeException unavailable){return VoiceLatencyTrials.UNSET;}
 }
 /** The start threshold (API 31+), else the whole buffer, which a stream must fill before it plays. */
 @Override public int startThresholdFrames(){
  try{return android.os.Build.VERSION.SDK_INT>=31?track.getStartThresholdInFrames():track.getBufferSizeInFrames();}
  catch(RuntimeException unavailable){return 0;}
 }
 public void setVolume(float volume){try{track.setVolume(volume);}catch(RuntimeException ignored){/* Released. */}}
 public void abort(){try{track.pause();track.flush();}catch(RuntimeException ignored){/* Already stopped or released. */}}
 public void stop(){try{track.stop();}catch(RuntimeException ignored){/* Already stopped. */}}
 public void release(){track.release();}
}
