package ai.eliza.voice;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import java.util.concurrent.Executor;

/**
 * Android glue for {@link SpeechAudioFocusPolicy}: transient, duckable audio focus for assistant
 * speech (USAGE_ASSISTANT, CONTENT_TYPE_SPEECH), held only while an utterance plays, plus the
 * telephony/VoIP mode checks that keep speech and assistant capture off an active call.
 */
public final class SpeechAudioFocus {
 public interface Changes { void apply(SpeechAudioFocusPolicy.Action action,boolean callActive); }
 public static final AudioAttributes ATTRIBUTES=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
 private final AudioManager audio;
 private final SpeechAudioFocusPolicy policy=new SpeechAudioFocusPolicy();
 private final AudioFocusRequest request;
 private AudioManager.OnModeChangedListener modeListener;

 public SpeechAudioFocus(Context context,Handler main,Changes changes){
  audio=context.getSystemService(AudioManager.class);
  // Speech content is not auto-ducked by the platform; the duck callback lowers it here instead.
  request=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
   .setAudioAttributes(ATTRIBUTES).setAcceptsDelayedFocusGain(false).setWillPauseWhenDucked(true)
   .setOnAudioFocusChangeListener(change->{
    SpeechAudioFocusPolicy.Event event=event(change);if(event==null)return;
    SpeechAudioFocusPolicy.Action action=policy.changed(event);
    if(action!=SpeechAudioFocusPolicy.Action.NONE)changes.apply(action,callActive());
   },main).build();
 }
 public static SpeechAudioFocusPolicy.Event event(int change){
  switch(change){
   case AudioManager.AUDIOFOCUS_GAIN:return SpeechAudioFocusPolicy.Event.GAIN;
   case AudioManager.AUDIOFOCUS_LOSS:return SpeechAudioFocusPolicy.Event.LOSS;
   case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:return SpeechAudioFocusPolicy.Event.LOSS_TRANSIENT;
   case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:return SpeechAudioFocusPolicy.Event.LOSS_TRANSIENT_CAN_DUCK;
   default:return null;
  }
 }
 public static SpeechAudioFocusPolicy.Mode mode(int mode){
  switch(mode){
   case AudioManager.MODE_NORMAL:return SpeechAudioFocusPolicy.Mode.NORMAL;
   case AudioManager.MODE_RINGTONE:return SpeechAudioFocusPolicy.Mode.RINGTONE;
   case AudioManager.MODE_IN_CALL:return SpeechAudioFocusPolicy.Mode.IN_CALL;
   case AudioManager.MODE_IN_COMMUNICATION:return SpeechAudioFocusPolicy.Mode.IN_COMMUNICATION;
   case AudioManager.MODE_CALL_SCREENING:return SpeechAudioFocusPolicy.Mode.CALL_SCREENING;
   case AudioManager.MODE_CALL_REDIRECT:return SpeechAudioFocusPolicy.Mode.CALL_REDIRECT;
   case AudioManager.MODE_COMMUNICATION_REDIRECT:return SpeechAudioFocusPolicy.Mode.COMMUNICATION_REDIRECT;
   default:return SpeechAudioFocusPolicy.Mode.OTHER;
  }
 }
 public SpeechAudioFocusPolicy.Mode mode(){return audio==null?SpeechAudioFocusPolicy.Mode.OTHER:mode(audio.getMode());}
 public boolean callActive(){return SpeechAudioFocusPolicy.callActive(mode());}
 /** Null once focus is held (requested now or already held); otherwise the refusal code. Main thread. */
 public String acquire(){
  String refusal=SpeechAudioFocusPolicy.admission(mode());
  if(refusal!=null)return refusal;
  if(policy.held())return null;
  if(audio==null)return SpeechAudioFocusPolicy.FOCUS_DENIED;
  return policy.granted(audio.requestAudioFocus(request)==AudioManager.AUDIOFOCUS_REQUEST_GRANTED)?null:SpeechAudioFocusPolicy.FOCUS_DENIED;
 }
 /** The utterance ended or was stopped. Main thread. */
 public void release(){
  boolean held=policy.held();policy.released();
  if(held&&audio!=null)try{audio.abandonAudioFocusRequest(request);}catch(RuntimeException ignored){/* Nothing held. */}
 }
 /**
  * Android 12+: calls a hook when the audio mode moves into a call, so assistant capture and speech
  * stop when a call starts. Earlier releases rely on the start-time checks and focus loss.
  */
 public void watchCalls(Executor executor,Runnable onCall){
  if(audio==null||Build.VERSION.SDK_INT<Build.VERSION_CODES.S||modeListener!=null)return;
  modeListener=mode->{if(SpeechAudioFocusPolicy.callActive(mode(mode)))onCall.run();};
  try{audio.addOnModeChangedListener(executor,modeListener);}catch(RuntimeException unavailable){modeListener=null;}
 }
 public void close(){
  release();
  if(modeListener!=null&&Build.VERSION.SDK_INT>=Build.VERSION_CODES.S)try{audio.removeOnModeChangedListener(modeListener);}catch(RuntimeException ignored){/* Removed. */}
  modeListener=null;
 }
}
