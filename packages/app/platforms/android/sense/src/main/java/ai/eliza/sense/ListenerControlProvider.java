package ai.eliza.sense;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;

/**
 * The listener's only exported programmatic surface, for the host's settings and status UI. Callers
 * must hold the signature permission {@link Listener#CONTROL_PERMISSION}. It reports state text
 * and can only reduce capability (pause, turn off); enabling and resuming happen in the listener's
 * own UI with the user present. It never returns audio, transcripts or timestamps of speech.
 */
public class ListenerControlProvider extends ContentProvider {
 static final String STATUS="status",PAUSE="pause",TURN_OFF="turnOff";

 @Override public boolean onCreate(){return true;}

 @Override public Bundle call(String method,String arg,Bundle extras){
  if(getContext().checkCallingPermission(Listener.CONTROL_PERMISSION)!=PackageManager.PERMISSION_GRANTED)
   throw new SecurityException("Listener control permission required");
  long identity=Binder.clearCallingIdentity();
  try{
   ListenerStore store=new ListenerStore(getContext());
   boolean resetSaved=true;
   if("reset".equals(method)){resetSaved=store.reset();Listener.refresh(getContext());}
   else if(PAUSE.equals(method)){store.pause(ListenerPolicy.PAUSE_UNTIL_RESUMED);Listener.refresh(getContext());}
   else if(TURN_OFF.equals(method)){store.setEnabled(false);Listener.refresh(getContext());}
   else if(!STATUS.equals(method))throw new IllegalArgumentException("Unknown method");
   ListenerPolicy.State state=Listener.state(getContext());
   Bundle out=new Bundle();
   out.putString("state",state.name());
   out.putString("label",ListenerStore.storageFailed()?"Listening is off. Settings could not be saved; reopen listener settings.":ListenerPolicy.label(state));
   out.putBoolean("saved",resetSaved&&!ListenerStore.storageFailed());
   out.putBoolean("consented",ListenerPolicy.consented(store.consentVersion()));
   out.putBoolean("listening",ListenerPolicy.processesAudio(state));
   out.putBoolean("microphoneOpen",ListenerPolicy.holdsMicrophone(state));
   return out;
  }finally{Binder.restoreCallingIdentity(identity);}
 }

 @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){return null;}
 @Override public String getType(Uri uri){return null;}
 @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
 @Override public int delete(Uri uri,String selection,String[] args){throw new UnsupportedOperationException();}
 @Override public int update(Uri uri,ContentValues values,String selection,String[] args){throw new UnsupportedOperationException();}
}
