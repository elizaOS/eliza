package ai.eliza.voice;

import android.media.AudioFormat;
import android.media.AudioTimestamp;
import android.media.AudioTrack;

/**
 * AudioTrack (MODE_STREAM, mono float PCM, assistant/speech attributes) behind
 * {@link StreamingSpeechPlayback.Output}. Opened on the playback writer thread. Nothing is written
 * to storage; the track's buffer is flushed on abort.
 */
public final class AudioTrackSpeechOutput implements StreamingSpeechPlayback.Output {
 /** Platform buffer target: about 200 ms, never below the device minimum. */
 public static final int BUFFER_MS=200;
 private final AudioTrack track;
 private final AudioTimestamp stamp=new AudioTimestamp();
 private final int rate;

 private AudioTrackSpeechOutput(AudioTrack track,int rate){this.track=track;this.rate=rate;}

 public static AudioTrackSpeechOutput open(int rate){
  try{android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);}catch(RuntimeException ignored){/* Default priority still plays. */}
  int minimum=AudioTrack.getMinBufferSize(rate,AudioFormat.CHANNEL_OUT_MONO,AudioFormat.ENCODING_PCM_FLOAT);
  if(minimum<=0)throw new IllegalStateException("Float speech output unsupported");
  int bytes=Math.max(minimum,rate*4*BUFFER_MS/1000);
  AudioTrack track=new AudioTrack.Builder()
   .setAudioAttributes(SpeechAudioFocus.ATTRIBUTES)
   .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
   .setTransferMode(AudioTrack.MODE_STREAM)
   .setBufferSizeInBytes(bytes)
   .build();
  if(track.getState()!=AudioTrack.STATE_INITIALIZED){track.release();throw new IllegalStateException("Speech output unavailable");}
  return new AudioTrackSpeechOutput(track,rate);
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
   return VoiceLatencyTrials.frameTimeNs(stamp.nanoTime,stamp.framePosition,frame,rate);
  }catch(RuntimeException unavailable){return VoiceLatencyTrials.UNSET;}
 }
 public void setVolume(float volume){try{track.setVolume(volume);}catch(RuntimeException ignored){/* Released. */}}
 public void abort(){try{track.pause();track.flush();}catch(RuntimeException ignored){/* Already stopped or released. */}}
 public void stop(){try{track.stop();}catch(RuntimeException ignored){/* Already stopped. */}}
 public void release(){track.release();}
}
