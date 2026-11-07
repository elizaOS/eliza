package ai.eliza.sense;

import android.Manifest;
import android.app.Application;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;

/**
 * The image starts this persistent, direct-boot-aware process at boot and restarts it after a
 * crash. Each start counts an unclean exit when a capture session was left open in this boot by
 * this install (the crash-loop breaker; shutdowns, reboots and package updates do not count), then
 * converges on policy: off without consent, waiting before first unlock, and
 * listening only after unlock with consent and permission.
 */
public class SenseApplication extends Application {
 @Override public void onCreate(){
  super.onCreate();
  boolean granted=checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED;
  new ListenerStore(this).recordProcessStart(System.currentTimeMillis(),granted);
  IntentFilter changes=new IntentFilter(Intent.ACTION_USER_UNLOCKED);
  // User switches: capture stops while another user is in the foreground.
  changes.addAction(Intent.ACTION_USER_FOREGROUND);
  changes.addAction(Intent.ACTION_USER_BACKGROUND);
  // The listening notification is the indicator; blocking it turns listening off at once.
  changes.addAction(NotificationManager.ACTION_APP_BLOCK_STATE_CHANGED);
  changes.addAction(NotificationManager.ACTION_NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED);
  changes.addAction(Intent.ACTION_SHUTDOWN);
  // The listener's own screen state resolves an unknown display state in SystemUI's lease report.
  changes.addAction(Intent.ACTION_SCREEN_ON);
  changes.addAction(Intent.ACTION_SCREEN_OFF);
  android.os.PowerManager power=getSystemService(android.os.PowerManager.class);
  Listener.screenInteractive=power==null||power.isInteractive();
  registerReceiver(new BroadcastReceiver(){
   @Override public void onReceive(Context context,Intent intent){
    // A clean shutdown is not a crash: close the open-session marker before the process is killed.
    if(Intent.ACTION_SHUTDOWN.equals(intent.getAction())){new ListenerStore(context).setSessionOpen(false);return;}
    if(Intent.ACTION_SCREEN_ON.equals(intent.getAction()))Listener.screenInteractive=true;
    else if(Intent.ACTION_SCREEN_OFF.equals(intent.getAction()))Listener.screenInteractive=false;
    Listener.refresh(context);
   }
  },changes,Context.RECEIVER_NOT_EXPORTED);
  Listener.refresh(this);
 }
}
