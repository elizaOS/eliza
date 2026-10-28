package ai.eliza.sense;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Notification actions. Not exported: only this package's immutable PendingIntents reach it. */
public class ListenerActionReceiver extends BroadcastReceiver {
 static final String PAUSE=BuildConfig.APPLICATION_ID+".action.PAUSE";
 static final String RESUME=BuildConfig.APPLICATION_ID+".action.RESUME";
 static final String STOP=BuildConfig.APPLICATION_ID+".action.STOP";
 /** The user dismissed the listening notification (possible for foreground services since Android 14). */
 static final String DISMISSED=BuildConfig.APPLICATION_ID+".action.DISMISSED";

 @Override public void onReceive(Context context,Intent intent){
  String action=intent==null?null:intent.getAction();
  ListenerStore store=new ListenerStore(context);
  // Dismissing the indicator is treated as a pause: listening never continues without it. The
  // paused service re-posts its notification, so Resume stays one tap away.
  if(PAUSE.equals(action)||DISMISSED.equals(action))store.pause(ListenerPolicy.PAUSE_UNTIL_RESUMED);
  else if(RESUME.equals(action))store.resume();
  else if(STOP.equals(action))store.setEnabled(false);
  else return;
  Listener.refresh(context);
 }
}
