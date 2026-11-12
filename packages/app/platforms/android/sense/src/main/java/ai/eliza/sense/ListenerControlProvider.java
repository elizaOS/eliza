package ai.eliza.sense;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import android.os.Looper;
import android.os.SystemClock;

/**
 * The listener's only exported programmatic surface, for the host's settings and status UI. Callers
 * must hold the signature permission {@link Listener#CONTROL_PERMISSION}. It reports state text
 * and can only reduce capability (pause, turn off); enabling and resuming happen in the listener's
 * own UI with the user present. Reset, for a data reset, erases the listener's settings, consent and
 * storage failure state and stops the service; it can never grant consent, enable or resume
 * listening. It never returns audio, transcripts or timestamps of speech.
 */
public class ListenerControlProvider extends ContentProvider {
 static final String STATUS="status",PAUSE="pause",TURN_OFF="turnOff",RESET="reset";

 @Override public boolean onCreate(){return true;}

 @Override public Bundle call(String method,String arg,Bundle extras){
  if(getContext().checkCallingPermission(Listener.CONTROL_PERMISSION)!=PackageManager.PERMISSION_GRANTED)
   throw new SecurityException("Listener control permission required");
  long identity=Binder.clearCallingIdentity();
  try{
   ListenerStore store=new ListenerStore(getContext());
   boolean resetSaved=true;
   if(RESET.equals(method)){resetSaved=store.reset();Listener.refresh(getContext());}
   else if(PAUSE.equals(method)){store.pause(ListenerPolicy.PAUSE_UNTIL_RESUMED);Listener.refresh(getContext());}
   else if(TURN_OFF.equals(method)){store.setEnabled(false);Listener.refresh(getContext());}
   else if(!STATUS.equals(method))throw new IllegalArgumentException("Unknown method");
   ListenerPolicy.State state=Listener.state(getContext());
   if(!STATUS.equals(method))awaitRelease(state);
   Bundle out=new Bundle();
   out.putString("state",state.name());
   out.putString("label",ListenerStore.storageFailed()?ConsentActivity.STORAGE_FAILED:ListenerPolicy.label(state));
   out.putBoolean("saved",resetSaved&&!ListenerStore.storageFailed());
   out.putBoolean("consented",ListenerPolicy.consented(store.consentVersion()));
   out.putBoolean("listening",ListenerPolicy.processesAudio(state));
   // What the service holds, not what the policy permits: a state can allow capture before the service starts.
   out.putBoolean("microphoneOpen",Listener.microphoneHeld);
   return out;
  }finally{Binder.restoreCallingIdentity(identity);}
 }

 /**
  * The service releases the microphone on its main thread after the stop above, so a pause, turn-off
  * or reset waits briefly for that before reporting it; a caller confirming a stop reads microphoneOpen.
  */
 private static void awaitRelease(ListenerPolicy.State state){
  if(Looper.myLooper()==Looper.getMainLooper())return;
  long deadline=SystemClock.elapsedRealtime()+2000;
  while(Listener.microphoneHeld&&!ListenerPolicy.holdsMicrophone(state)&&SystemClock.elapsedRealtime()<deadline){
   try{Thread.sleep(20);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();return;}
  }
 }

 @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){return null;}
 @Override public String getType(Uri uri){return null;}
 @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
 @Override public int delete(Uri uri,String selection,String[] args){throw new UnsupportedOperationException();}
 @Override public int update(Uri uri,ContentValues values,String selection,String[] args){throw new UnsupportedOperationException();}
}
