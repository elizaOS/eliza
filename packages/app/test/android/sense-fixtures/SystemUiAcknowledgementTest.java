package com.android.systemui.privacy;

import android.content.Context;
import android.hardware.display.DisplayManager;
import android.media.AudioManager;
import android.os.Handler;
import android.view.Display;
import android.view.ViewGroup;
import com.android.systemui.plugins.statusbar.StatusBarStateController;
import com.android.systemui.settings.UserTracker;
import com.android.systemui.statusbar.CommandQueue;
import com.android.systemui.statusbar.NotificationListener;
import com.android.systemui.statusbar.policy.KeyguardStateController;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.concurrent.Executor;

/**
 * Host-JVM run of SenseListeningController's acknowledgement composition through stubs: lock
 * screen and AOD (keyguard chip), unlocked status bar, expanded shade and immersive mode, and the
 * display state. Stub views report what the test sets; nothing here measures a real view.
 */
public final class SystemUiAcknowledgementTest {
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 static final int UID=10_042;
 static boolean locked,expanded;static int displayState=Display.STATE_ON;
 static android.service.notification.StatusBarNotification[] active=new android.service.notification.StatusBarNotification[0];

 static void show(android.view.View view,boolean on){
  view.stubAttached=on;view.stubShown=on;view.stubWindowVisibility=on?android.view.View.VISIBLE:android.view.View.GONE;
  view.stubWidth=view.stubHeight=10;view.stubVisibleWidth=view.stubVisibleHeight=on?10:0;
 }
 static SenseListeningChipView chip(Context context,boolean keyguard,ViewGroup host){
  SenseListeningChipView view=keyguard?new SenseListeningChipView(context):new SenseListeningChipView(context,null);
  view.stubParent=host;view.onVisibilityAggregated(true);return view;
 }

 static com.android.systemui.statusbar.policy.KeyguardStateController.Callback keyguardCallback(SenseListeningController controller)throws Exception{
  Field f=SenseListeningController.class.getDeclaredField("keyguardShowing");f.setAccessible(true);
  return (com.android.systemui.statusbar.policy.KeyguardStateController.Callback)f.get(controller);
 }

 public static void main(String[] args)throws Exception{
  Context context=new Context();
  Display display=new Display();
  DisplayManager displays=new DisplayManager(){@Override public Display getDisplay(int id){display.stubState=displayState;return id==Display.DEFAULT_DISPLAY?display:null;}};
  StatusBarStateController statusBar=new StatusBarStateController(){
   public boolean isExpanded(){return expanded;} public boolean isDozing(){return displayState==Display.STATE_DOZE;} public void addCallback(StateListener l){}};
  KeyguardStateController keyguard=new KeyguardStateController(){public boolean isShowing(){return locked;} public void addCallback(Callback c){}};
  UserTracker users=new UserTracker(){public int getUserId(){return 0;} public boolean isUserSwitching(){return false;} public void addCallback(Callback c,Executor e){}};
  NotificationListener notifications=new NotificationListener(){@Override public android.service.notification.StatusBarNotification[] getActiveNotifications(){return active;}};
  CommandQueue commands=new CommandQueue();
  SenseListeningController controller=new SenseListeningController(context,new AudioManager(),new Handler(),Runnable::run,users,notifications,statusBar,keyguard,commands,displays,()->new com.android.systemui.scene.ui.view.WindowRootView(context),callback->{});
  Field uid=SenseListeningController.class.getDeclaredField("uid");uid.setAccessible(true);uid.setInt(controller,UID);
  Field observed=SenseListeningController.class.getDeclaredField("active");observed.setAccessible(true);observed.setBoolean(controller,true);
  Field bars=SenseListeningController.class.getDeclaredField("systemBars");bars.setAccessible(true);CommandQueue.Callbacks systemBars=(CommandQueue.Callbacks)bars.get(controller);
  Method ack=SenseListeningController.class.getDeclaredMethod("acknowledgement");ack.setAccessible(true);
  ViewGroup statusHost=new ViewGroup(context),lockHost=new ViewGroup(context);
  SenseListeningChipView statusChip=chip(context,false,statusHost),lockChip=chip(context,true,lockHost);
  check(!statusChip.keyguardSurface()&&lockChip.keyguardSurface(),"inflated chip is the status bar's, code-built chip the keyguard's");
  SenseListeningController.attach(statusChip);SenseListeningController.attach(lockChip);
  statusChip.render(true);lockChip.render(true);
  // Unlocked, status bar shown.
  show(statusHost,true);show(statusChip,true);show(lockHost,false);show(lockChip,false);
  SenseListeningLease.Acknowledgement a=(SenseListeningLease.Acknowledgement)ack.invoke(controller);
  check(a.uid==UID&&a.surface&&a.chip&&a.recording&&"on".equals(a.display)&&"none".equals(a.reason),"unlocked status-bar chip");
  // Immersive app hides the status bar; a transient swipe reveals it.
  systemBars.onSystemBarAttributesChanged(Display.DEFAULT_DISPLAY,0,null,false,0,0,"app",null);
  a=(SenseListeningLease.Acknowledgement)ack.invoke(controller);
  check(!a.surface&&!a.chip&&"fullscreen".equals(a.reason),"immersive mode: the status bar is reported hidden, explained as fullscreen");
  systemBars.showTransient(Display.DEFAULT_DISPLAY,android.view.WindowInsets.Type.statusBars(),true);
  check(((SenseListeningLease.Acknowledgement)ack.invoke(controller)).surface,"transient reveal");
  systemBars.abortTransient(Display.DEFAULT_DISPLAY,android.view.WindowInsets.Type.statusBars());
  systemBars.onSystemBarAttributesChanged(1,0,null,false,0,~0,"other display",null);
  check(!((SenseListeningLease.Acknowledgement)ack.invoke(controller)).surface,"another display does not reset the default display");
  systemBars.onSystemBarAttributesChanged(Display.DEFAULT_DISPLAY,0,null,false,0,~0,"app",null);
  check(((SenseListeningLease.Acknowledgement)ack.invoke(controller)).surface,"status bar shown again");
  // Shade expanded: existing status/keyguard chips are covered; notification existence proves nothing.
  expanded=true;
  a=(SenseListeningLease.Acknowledgement)ack.invoke(controller);
  check(!a.surface&&"shade".equals(a.reason),"expanded shade without a measured indicator, explained as shade");
  android.app.Notification note=new android.app.Notification(){@Override public String getChannelId(){return "listening-indicator";}};note.flags=android.app.Notification.FLAG_ONGOING_EVENT;
  active=new android.service.notification.StatusBarNotification[]{new android.service.notification.StatusBarNotification(){
   @Override public android.app.Notification getNotification(){return note;} @Override public int getUid(){return UID;}
   @Override public String getPackageName(){return "ai.eliza.sense";} @Override public int getId(){return 1;}}};
  a=(SenseListeningLease.Acknowledgement)ack.invoke(controller);
  check(!a.surface&&!a.chip,"an active notification can be scrolled away or covered by QS and cannot grant a lease");
  // A real dedicated root child grants a lease independently of notification scroll/QS state.
  com.android.systemui.scene.ui.view.WindowRootView shadeRoot=new com.android.systemui.scene.ui.view.WindowRootView(context);
  SenseListeningChipView shadeChip=SenseListeningChipView.shade(context);
  Field rootField=SenseListeningController.class.getDeclaredField("shadeRoot");rootField.setAccessible(true);rootField.set(controller,shadeRoot);
  Field chipField=SenseListeningController.class.getDeclaredField("shadeChip");chipField.setAccessible(true);chipField.set(controller,shadeChip);
  Field stateField=SenseListeningController.class.getDeclaredField("shadeState");stateField.setAccessible(true);
  com.android.systemui.statusbar.phone.StatusBarWindowCallback shadeState=(com.android.systemui.statusbar.phone.StatusBarWindowCallback)stateField.get(controller);
  Method frame=SenseListeningController.class.getDeclaredMethod("prepareShadeFrame");frame.setAccessible(true);
  shadeState.onStateChanged(false,false,false,false,false,true,false,false);
  frame.invoke(controller);show(shadeRoot,true);show(shadeChip,true);shadeChip.onVisibilityAggregated(true);
  check(((SenseListeningLease.Acknowledgement)ack.invoke(controller)).chip,"measured fixed shade/QS chip counts");
  active=new android.service.notification.StatusBarNotification[0];
  check(((SenseListeningLease.Acknowledgement)ack.invoke(controller)).chip,"notification absence or scroll does not remove dedicated indicator");
  android.view.View compose=new android.view.View(context);compose.setZ(12);
  shadeRoot.addView(compose,new android.widget.FrameLayout.LayoutParams(-1,-1,0));
  check(!((SenseListeningLease.Acknowledgement)ack.invoke(controller)).surface,"later Compose child denies stale visibility before the next frame");
  check(Boolean.FALSE.equals(frame.invoke(controller)),"reorder cancels stale frame");
  check(shadeChip.topmostIn(shadeRoot)&&((SenseListeningLease.Acknowledgement)ack.invoke(controller)).chip,"next frame restores topmost dedicated chip");
  shadeRoot.stubInsets.stubInsets.top=24;shadeRoot.stubInsets.stubInsets.left=8;
  check(!((SenseListeningLease.Acknowledgement)ack.invoke(controller)).surface,"new cutout/insets deny stale layout lease");
  check(Boolean.FALSE.equals(frame.invoke(controller)),"inset placement requires a new layout frame");
  android.widget.FrameLayout.LayoutParams placed=(android.widget.FrameLayout.LayoutParams)shadeChip.getLayoutParams();
  check(placed.topMargin==24&&placed.leftMargin==8,"status-bar/cutout margins follow current insets");
  shadeRoot.stubLayoutRequested=true;
  check(!((SenseListeningLease.Acknowledgement)ack.invoke(controller)).surface,"pending layout does not acknowledge old geometry");shadeRoot.stubLayoutRequested=false;
  check(((SenseListeningLease.Acknowledgement)ack.invoke(controller)).chip,"completed inset layout restores measured lease");
  shadeChip.stubVisibleWidth=3;
  check(!((SenseListeningLease.Acknowledgement)ack.invoke(controller)).chip,"clipped shade chip does not count");shadeChip.stubVisibleWidth=10;
  shadeChip.stubAlpha=0.1f;
  check(!((SenseListeningLease.Acknowledgement)ack.invoke(controller)).chip,"faded shade chip does not count");shadeChip.stubAlpha=1;
  shadeRoot.stubFocus=false;
  check(!((SenseListeningLease.Acknowledgement)ack.invoke(controller)).surface,"another focused window denies shade lease");shadeRoot.stubFocus=true;
  for(int blocked=0;blocked<7;blocked++){
   shadeState.onStateChanged(blocked==0,blocked==1,blocked==2,blocked==3,blocked==4,true,blocked==5,blocked==6);
   check(!((SenseListeningLease.Acknowledgement)ack.invoke(controller)).surface,"security/doze/dream/communal transition denies shade lease "+blocked);
  }
  shadeState.onStateChanged(false,false,false,false,false,true,false,false);
  shadeRoot.removeAllViews();
  check(!((SenseListeningLease.Acknowledgement)ack.invoke(controller)).surface,"scene lifecycle teardown immediately denies old attachment");
  check(Boolean.FALSE.equals(frame.invoke(controller))&&shadeChip.getParent()==shadeRoot,"next lifecycle reattaches dedicated chip");
  show(shadeChip,false);
  note.flags=0;
  check(!((SenseListeningLease.Acknowledgement)ack.invoke(controller)).chip,"a notification cannot rescue a hidden dedicated chip");
  expanded=false;
  // Lock screen and AOD use the keyguard chip; the status-bar chip does not count while locked.
  // A hidden report within the debounce after a reported keyguard change is a transition.
  android.os.SystemClock.stubUptime=50_000;
  locked=true;keyguardCallback(controller).onKeyguardShowingChanged();
  a=(SenseListeningLease.Acknowledgement)ack.invoke(controller);
  check(!a.surface&&"transition".equals(a.reason),"locking: the keyguard chip not yet shown is a transition");
  android.os.SystemClock.stubUptime=50_999;
  check("transition".equals(((SenseListeningLease.Acknowledgement)ack.invoke(controller)).reason),"still inside the debounce");
  android.os.SystemClock.stubUptime=51_000;
  a=(SenseListeningLease.Acknowledgement)ack.invoke(controller);
  check(!a.surface&&"none".equals(a.reason),"after the debounce a hidden keyguard chip is unexplained");
  show(lockHost,true);show(lockChip,true);
  a=(SenseListeningLease.Acknowledgement)ack.invoke(controller);
  check(a.surface&&a.chip&&"on".equals(a.display),"lock-screen chip");
  displayState=Display.STATE_DOZE;
  a=(SenseListeningLease.Acknowledgement)ack.invoke(controller);
  check(a.surface&&a.chip&&"doze".equals(a.display),"AOD showing the keyguard chip");
  show(lockChip,false);show(lockHost,false);
  a=(SenseListeningLease.Acknowledgement)ack.invoke(controller);
  check(!a.surface&&"doze".equals(a.display)&&"aod".equals(a.reason),"AOD not showing the chip");
  displayState=Display.STATE_OFF;
  a=(SenseListeningLease.Acknowledgement)ack.invoke(controller);
  check("off".equals(a.display)&&"display_off".equals(a.reason),"display fully off");
  displayState=Display.STATE_UNKNOWN;
  a=(SenseListeningLease.Acknowledgement)ack.invoke(controller);
  check("unknown".equals(a.display)&&"none".equals(a.reason),"unknown display state is reported as unknown, with no reason");
  displayState=Display.STATE_ON;locked=false;show(statusHost,true);show(statusChip,true);
  SenseListeningController.detach(statusChip);
  a=(SenseListeningLease.Acknowledgement)ack.invoke(controller);
  check(!a.surface&&"none".equals(a.reason),"a detached chip without an explained reason");
  uid.setInt(controller,-1);
  check(((SenseListeningLease.Acknowledgement)ack.invoke(controller)).uid==-1,"unverified listener acknowledges nothing");
  System.out.println("PASS SystemUI acknowledgement: status bar, immersive, shade, transition debounce, lock screen, AOD, display off, detach");
 }
}
