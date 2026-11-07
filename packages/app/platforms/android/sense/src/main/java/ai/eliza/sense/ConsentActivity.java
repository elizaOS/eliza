package ai.eliza.sense;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Explicit opt-in, status, pause and withdrawal for always-on listening. Listening is off until
 * the user reads this explanation, taps "Turn on" and grants both the microphone and notifications
 * (the listening notification is the indicator listening never runs without). Withdrawal clears the
 * consent record; a later change to what is captured or where it goes (a new consent version)
 * requires opting in again. Touches are ignored while another window covers this one.
 */
public class ConsentActivity extends Activity {
 private static final int REQUEST_MICROPHONE=1;
 static String explanation(){return
  "When on, this phone's microphone stays open in the background, including while the phone is locked, so you can say “"+BuildConfig.SENSE_WAKE_LABEL+"” instead of opening the app.\n\n"
  +"• Speech is detected and recognised on this phone. Audio is never uploaded and never saved.\n"
  +"• What you say is checked only for “"+BuildConfig.SENSE_WAKE_LABEL+"”. Anything not addressed to "+BuildConfig.SENSE_APP_NAME+" is discarded. When you say “"+BuildConfig.SENSE_WAKE_LABEL+"”, the "+BuildConfig.SENSE_APP_NAME+" app opens and handles your request as if you had opened it.\n"
  +"• A notification shows whenever listening is on or paused, including on the lock screen; listening does not run without it. The system microphone indicator is also expected to show while the microphone is open. Listening runs only while the system Listening indicator can be shown; if it stops being shown, listening turns off until you resume it.\n"
  +"• With the screen off, listening continues only while Always-on display shows the Listening indicator. If Always-on display is off, listening pauses while the screen is off and resumes when the indicator shows again.\n"
  +"• Pause or turn off at any time from the notification, the Quick Settings tile, the microphone privacy toggle or by saying “"+BuildConfig.SENSE_WAKE_LABEL+", stop listening”.\n"
  +"• Listening pauses while the phone rings, during calls, while sound or speech is playing (wake word only), whenever another app uses the microphone and while another user is using the phone. Calls are never recorded.\n"
  +"• Saying “"+BuildConfig.SENSE_WAKE_LABEL+"” while the phone is locked does nothing; unlock first.\n"
  +"• After a process or phone restart, unlock and turn listening on here again.\n\n"
  +"People near you may be heard. Only turn this on where that is lawful and appropriate.";}

 private static final String PENDING_GENERATION="pendingConsentGeneration";
 private static final String PENDING_PROCESS="pendingConsentProcess";
 private LinearLayout column;
 private long pendingConsentGeneration=-1;

 /**
  * The generation counter lives in this process, so a saved request is only restored into the
  * same process: after a restart the counter starts again and an old value must never match it.
  */
 private static long processIdentity(){return ((long)Process.myPid()<<40)^Process.getStartElapsedRealtime();}

 @Override protected void onCreate(Bundle state){
  super.onCreate(state);
  // A recreated activity (rotation while the permission dialog shows) keeps its pending request.
  if(state!=null&&state.getLong(PENDING_PROCESS,0)==processIdentity())pendingConsentGeneration=state.getLong(PENDING_GENERATION,-1);
  setTitle("Always-on listening");
  getWindow().setHideOverlayWindows(true);
  ScrollView scroll=new ScrollView(this);
  column=new LinearLayout(this);
  column.setOrientation(LinearLayout.VERTICAL);
  int pad=dp(20);
  column.setPadding(pad,pad,pad,pad);
  scroll.addView(column);
  scroll.setFitsSystemWindows(true);
  setContentView(scroll);
 }

 @Override protected void onResume(){super.onResume();render();}

 @Override protected void onSaveInstanceState(Bundle out){
  super.onSaveInstanceState(out);
  if(pendingConsentGeneration>=0){out.putLong(PENDING_GENERATION,pendingConsentGeneration);out.putLong(PENDING_PROCESS,processIdentity());}
 }

 private int dp(int value){return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP,value,getResources().getDisplayMetrics()));}

 private TextView text(String value,float size){
  TextView view=new TextView(this);
  view.setText(value);
  view.setTextSize(TypedValue.COMPLEX_UNIT_SP,size);
  view.setPadding(0,0,0,dp(16));
  column.addView(view);
  return view;
 }

 private void button(String label,View.OnClickListener click){
  Button button=new Button(this);
  button.setText(label);
  button.setFilterTouchesWhenObscured(true);
  button.setOnClickListener(click);
  column.addView(button,new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,LinearLayout.LayoutParams.WRAP_CONTENT));
 }

 private void render(){
  column.removeAllViews();
  ListenerStore store=new ListenerStore(this);
  ListenerPolicy.State state=Listener.state(this);
  boolean consented=ListenerPolicy.consented(store.consentVersion());
  TextView status=text(ListenerPolicy.label(state),22);
  status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
  text(explanation(),16);
  text("After the listening process restarts, turn listening on here again.",16);
  if (ListenerStore.storageFailed()) text("Listening is off. Your change could not be saved. Restart the listener and opt in again after fixing storage.",16);
  if(!consented||!store.enabled()||state==ListenerPolicy.State.PERMISSION_REQUIRED||state==ListenerPolicy.State.STOPPED_AFTER_ERRORS
   ||(state==ListenerPolicy.State.NOTIFICATIONS_REQUIRED&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)){
   button(consented?"Turn on listening":"I understand — turn on listening",view->requestMicrophone());
  }
  if(state==ListenerPolicy.State.NOTIFICATIONS_REQUIRED)button("Allow the listening notification",view->openNotificationSettings());
  if(consented&&!ListenerNotifications.alwaysOnDisplayEnabled(this))text("Always-on display is off: listening pauses whenever the screen is off.",16);
  button("Always-on display settings",view->openAlwaysOnDisplaySettings());
  if(state==ListenerPolicy.State.PAUSED_USER||state==ListenerPolicy.State.STOPPED_INDICATOR_LOST)button("Resume listening",view->{store.resume();changed();});
  if(ListenerPolicy.holdsMicrophone(state)||state==ListenerPolicy.State.PAUSED_CALL||ListenerPolicy.indicatorPaused(state)){
   button("Pause for 15 minutes",view->{store.pause(ListenerPolicy.pauseUntil(SystemClock.elapsedRealtime(),15));changed();});
   button("Pause for 1 hour",view->{store.pause(ListenerPolicy.pauseUntil(SystemClock.elapsedRealtime(),60));changed();});
   button("Pause until I resume",view->{store.pause(ListenerPolicy.PAUSE_UNTIL_RESUMED);changed();});
  }
  if(consented&&store.enabled())button("Turn off listening",view->{store.setEnabled(false);changed();});
  if(consented)button("Turn off and withdraw consent",view->{store.revokeConsent();changed();});
 }

 private void changed(){Listener.refresh(this);render();}

 /** Lock-screen settings hold Always-on display in AOSP Settings; display settings are the fallback. */
 private void openAlwaysOnDisplaySettings(){
  for(String action:new String[]{ListenerNotifications.LOCK_SCREEN_SETTINGS,Settings.ACTION_DISPLAY_SETTINGS}){
   try{startActivity(new Intent(action));return;}catch(RuntimeException unavailable){}
  }
 }

 /** The listening channel or the app's notifications are blocked: the user re-enables them in system Settings. */
 private void openNotificationSettings(){
  Intent intent=new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName());
  try{startActivity(intent);}catch(RuntimeException unavailable){}
 }

 private void requestMicrophone(){
  if(pendingConsentGeneration>=0)return;
  pendingConsentGeneration=ListenerStore.consentGeneration();
  String[] wanted=checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED
   ?new String[]{Manifest.permission.RECORD_AUDIO}:new String[]{Manifest.permission.RECORD_AUDIO,Manifest.permission.POST_NOTIFICATIONS};
  requestPermissions(wanted,REQUEST_MICROPHONE);
 }

 @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results){
  super.onRequestPermissionsResult(code,permissions,results);
  if(code!=REQUEST_MICROPHONE)return;
  long generation=pendingConsentGeneration;pendingConsentGeneration=-1;
  if(generation<0)return;
  // Consent needs both: the microphone, and the notification that is listening's visible indicator.
  if(!ListenerPolicy.consentPermissionsGranted(checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED,
   checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED)){render();return;}
  new ListenerStore(this).grantConsent(System.currentTimeMillis(),generation);
  changed();
 }
}
