package com.android.systemui.privacy;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.*;
import android.content.pm.*;
import android.hardware.display.DisplayManager;
import android.media.*;
import android.os.*;
import android.service.notification.StatusBarNotification;
import android.view.Display;
import android.graphics.Insets;
import android.view.Gravity;
import android.view.View;
import android.view.ViewTreeObserver;
import android.widget.FrameLayout;
import com.android.systemui.scene.ui.view.WindowRootView;
import com.android.systemui.statusbar.NotificationShadeWindowController;
import com.android.systemui.statusbar.phone.StatusBarWindowCallback;
import javax.inject.Provider;
import android.view.WindowInsets;
import com.android.internal.statusbar.LetterboxDetails;
import com.android.internal.view.AppearanceRegion;
import com.android.systemui.CoreStartable;
import com.android.systemui.dagger.SysUISingleton;
import com.android.systemui.dagger.qualifiers.Background;
import com.android.systemui.dagger.qualifiers.Main;
import com.android.systemui.plugins.statusbar.StatusBarStateController;
import com.android.systemui.res.R;
import com.android.systemui.settings.UserTracker;
import com.android.systemui.statusbar.CommandQueue;
import com.android.systemui.statusbar.NotificationListener;
import com.android.systemui.statusbar.policy.KeyguardStateController;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.Executor;
import javax.inject.Inject;

/**
 * SystemUI-owned microphone truth. Notification actions are capabilities, never capture evidence.
 * It also holds the listener's indicator health lease ({@link SenseListeningLease}), acknowledging
 * only what its own views measure, so the listener stops when this indicator cannot be shown.
 */
@SysUISingleton
public final class SenseListeningController implements CoreStartable {
 private static SenseListeningController instance;
 private static final Set<SenseListeningChipView> views=new HashSet<>(); // main thread only
 private final Context context;private final AudioManager audio;private final Handler main;
 private final UserTracker users;private final NotificationListener notifications;
 private final SenseListeningLease lease;
 private final String listenerPackage,hostPackage,receiverClass;
 private final StatusBarStateController statusBar;private final KeyguardStateController keyguard;
 private final CommandQueue commands;private final DisplayManager displays;
 private int uid=-1;private boolean active;
 private final Provider<WindowRootView> windowRoot;
 private final NotificationShadeWindowController shadeWindow;
 private WindowRootView shadeRoot;
 private SenseListeningChipView shadeChip;
 // A window-state callback is required before the shade can grant a lease.
 private boolean shadeStateKnown,shadeBlocked=true;
 private final StatusBarWindowCallback shadeState=(showing,occluded,goingAway,bouncer,dozing,expanded,dreaming,communal)->{
  shadeStateKnown=true;
  shadeBlocked=showing||occluded||goingAway||bouncer||dozing||dreaming||communal;
  if(shadeChip!=null)shadeChip.render(active&&shadeEligible());
  transition();
 };
 private boolean shadeEligible(){return shadeStateKnown&&!shadeBlocked&&!keyguard.isShowing()&&!keyguard.isOccluded()
  &&statusBar.isExpanded()&&!statusBar.isDozing()&&users.getUserId()==0&&!users.isUserSwitching();}
 /** Maintain one non-scrolling, inset-safe child in the common legacy/Compose window root.
  * Compose may add children after CoreStartable starts, or remove all children on teardown.
  * Reordering invalidates this frame; acknowledgement independently verifies current ordering.
  */
 private boolean prepareShadeFrame(){
  if(shadeChip.getParent()!=shadeRoot){
   if(shadeChip.getParent()!=null)return true; // Unexpected reparenting never grants a lease.
   FrameLayout.LayoutParams params=new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT,FrameLayout.LayoutParams.WRAP_CONTENT,Gravity.TOP|Gravity.CENTER_HORIZONTAL);
   shadeRoot.addView(shadeChip,params);
   shadeChip.render(active&&shadeEligible());
   return false;
  }
  shadeChip.renderShade(active&&shadeEligible());
  if(!shadeEligible())return true;
  WindowInsets insets=shadeRoot.getRootWindowInsets();
  if(insets==null){shadeChip.setVisibility(View.GONE);return true;}
  Insets safe=insets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());
  FrameLayout.LayoutParams params=(FrameLayout.LayoutParams)shadeChip.getLayoutParams();
  if(params.topMargin!=safe.top||params.leftMargin!=safe.left||params.rightMargin!=safe.right||params.bottomMargin!=safe.bottom){
   params.topMargin=safe.top;params.leftMargin=safe.left;params.rightMargin=safe.right;params.bottomMargin=safe.bottom;
   shadeChip.setLayoutParams(params);return false;
  }
  float highest=0;
  for(int i=0;i<shadeRoot.getChildCount();i++){View child=shadeRoot.getChildAt(i);if(child!=shadeChip)highest=Math.max(highest,child.getZ());}
  if(!Float.isFinite(highest))return true; // Measurement also rejects invalid ordering.
  boolean changed=shadeRoot.indexOfChild(shadeChip)!=shadeRoot.getChildCount()-1||shadeChip.getZ()!=highest;
  if(changed){shadeChip.setZ(highest);shadeChip.bringToFront();return false;}
  return true;
 }
 private final ViewTreeObserver.OnPreDrawListener shadeFrame=this::prepareShadeFrame;
 private void installShadeSurface(){
  shadeRoot=windowRoot.get();shadeChip=SenseListeningChipView.shade(context);
  shadeRoot.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener(){
   @Override public void onViewAttachedToWindow(View view){view.getViewTreeObserver().addOnPreDrawListener(shadeFrame);}
   @Override public void onViewDetachedFromWindow(View view){view.getViewTreeObserver().removeOnPreDrawListener(shadeFrame);surfaceChanged();}
  });
  if(shadeRoot.isAttachedToWindow())shadeRoot.getViewTreeObserver().addOnPreDrawListener(shadeFrame);
  prepareShadeFrame();
 }
 private boolean shadeInsetsApplied(){
  WindowInsets insets=shadeRoot.getRootWindowInsets();
  if(insets==null||shadeRoot.isLayoutRequested())return false;
  Insets safe=insets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());
  FrameLayout.LayoutParams params=(FrameLayout.LayoutParams)shadeChip.getLayoutParams();
  return params.topMargin==safe.top&&params.leftMargin==safe.left&&params.rightMargin==safe.right&&params.bottomMargin==safe.bottom;
 }
 private boolean shadeSurfaceVisible(){
  return shadeEligible()&&shadeRoot!=null&&shadeChip!=null&&shadeChip.getParent()==shadeRoot
   &&shadeRoot.hasWindowFocus()&&shadeInsetsApplied()&&shadeChip.topmostIn(shadeRoot)
   &&shadeChip.hostVisible();
 }
 /** Default display: insets types the top app requested visible (immersive hides the status bar) and a transient reveal. */
 private int requestedVisibleTypes=~0;private boolean statusBarTransient;
 /** Uptime of the last reported keyguard, doze, shade-state or display-state change (main thread). */
 private long transitionAt=-1;
 private void transition(){transitionAt=SystemClock.uptimeMillis();surfaceChanged();}
 private final StatusBarStateController.StateListener shadeAndDoze=new StatusBarStateController.StateListener(){
  @Override public void onExpandedChanged(boolean expanded){surfaceChanged();}
  @Override public void onDozingChanged(boolean dozing){transition();}
  @Override public void onStateChanged(int state){transition();}
 };
 private final KeyguardStateController.Callback keyguardShowing=new KeyguardStateController.Callback(){
  @Override public void onKeyguardShowingChanged(){transition();}
 };
 private final DisplayManager.DisplayListener displayState=new DisplayManager.DisplayListener(){
  @Override public void onDisplayAdded(int id){}
  @Override public void onDisplayRemoved(int id){}
  @Override public void onDisplayChanged(int id){if(id==Display.DEFAULT_DISPLAY)transition();}
 };
 private final CommandQueue.Callbacks systemBars=new CommandQueue.Callbacks(){
  @Override public void onSystemBarAttributesChanged(int displayId,int appearance,AppearanceRegion[] regions,boolean navbarColorManagedByIme,
    int behavior,int requestedVisibleTypes,String packageName,LetterboxDetails[] letterboxDetails){
   if(displayId!=Display.DEFAULT_DISPLAY)return;
   SenseListeningController.this.requestedVisibleTypes=requestedVisibleTypes;surfaceChanged();
  }
  @Override public void showTransient(int displayId,int types,boolean isGestureOnSystemBar){
   if(displayId==Display.DEFAULT_DISPLAY&&(types&WindowInsets.Type.statusBars())!=0){statusBarTransient=true;surfaceChanged();}
  }
  @Override public void abortTransient(int displayId,int types){
   if(displayId==Display.DEFAULT_DISPLAY&&(types&WindowInsets.Type.statusBars())!=0){statusBarTransient=false;surfaceChanged();}
  }
 };
 private final AudioManager.AudioRecordingCallback recording=new AudioManager.AudioRecordingCallback(){
  @Override public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs){refresh(configs);}
 };
 private final UserTracker.Callback userCallback=new UserTracker.Callback(){
  @Override public void onBeforeUserSwitching(int user){uid=-1;active=false;publish();}
  @Override public void onUserChanged(int user,Context userContext){refreshCurrent();}
 };
 @Inject public SenseListeningController(Context context,AudioManager audio,@Main Handler main,@Background Executor background,
   UserTracker users,NotificationListener notifications,StatusBarStateController statusBar,KeyguardStateController keyguard,
   CommandQueue commands,DisplayManager displays,Provider<WindowRootView> windowRoot,NotificationShadeWindowController shadeWindow){
  this.context=context;this.audio=audio;this.main=main;this.users=users;this.notifications=notifications;
  this.statusBar=statusBar;this.keyguard=keyguard;this.commands=commands;this.displays=displays;this.windowRoot=windowRoot;this.shadeWindow=shadeWindow;
  listenerPackage=context.getString(R.string.config_senseListeningPackage);
  hostPackage=context.getString(R.string.config_senseListeningHostPackage);
  receiverClass=context.getString(R.string.config_senseListeningReceiverClass);
  lease=new SenseListeningLease(context,main,background,this::acknowledgement,listenerPackage);}
 @Override public void start(){
  instance=this;
  shadeWindow.registerCallback(shadeState);
  installShadeSurface();
  audio.registerAudioRecordingCallback(recording,main);
  users.addCallback(userCallback,main::post);
  IntentFilter filter=new IntentFilter();filter.addAction(Intent.ACTION_PACKAGE_ADDED);filter.addAction(Intent.ACTION_PACKAGE_REMOVED);filter.addAction(Intent.ACTION_PACKAGE_REPLACED);filter.addDataScheme("package");
  context.registerReceiver(new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){refreshCurrent();}},filter,null,main,Context.RECEIVER_NOT_EXPORTED);
  refreshCurrent();
  statusBar.addCallback(shadeAndDoze);
  keyguard.addCallback(keyguardShowing);
  displays.registerDisplayListener(displayState,main);
  commands.addCallback(systemBars);
  lease.start();
 }
 static void attach(SenseListeningChipView view){views.add(view);if(instance!=null)instance.refreshCurrent();else view.render(false);}
 static void detach(SenseListeningChipView view){views.remove(view);surfaceChanged();}
 static void surfaceChanged(){if(instance!=null)instance.lease.now();}
 /**
  * Main thread: what SystemUI itself measures and reports. Unverified identity or user switching
  * acknowledges nothing. Lock screen and AOD use the keyguard chip; the unlocked status bar uses
  * the status-bar chip unless the shade covers it or an app hid the status bar; the expanded shade
  * counts only through the measured, topmost dedicated shade chip. The display state lets the
  * listener pause (not stop) while nothing can be shown.
  */
 private SenseListeningLease.Acknowledgement acknowledgement(){
  boolean admitted=uid!=-1&&!users.isUserSwitching()&&users.getUserId()==0;
  boolean locked=keyguard.isShowing(),shade=statusBar.isExpanded();
  boolean hidden=SenseListeningPolicy.statusBarHidden(requestedVisibleTypes,WindowInsets.Type.statusBars(),statusBarTransient);
  boolean surface=false,chip=false;
  for(SenseListeningChipView view:views){
   if(view.shadeSurface())continue;
   boolean shown=view.chipVisible(),host=shown||view.hostVisible();
   if(view.keyguardSurface()){chip|=SenseListeningPolicy.keyguardCounts(shown,locked,shade);surface|=SenseListeningPolicy.keyguardCounts(host,locked,shade);}
   else{chip|=SenseListeningPolicy.statusBarCounts(shown,locked,shade,hidden);surface|=SenseListeningPolicy.statusBarCounts(host,locked,shade,hidden);}
  }
  if(shadeSurfaceVisible()){surface=true;chip=shadeChip.chipVisible();}
  Display display=displays.getDisplay(Display.DEFAULT_DISPLAY);
  String state=SenseListeningPolicy.display(display==null?Display.STATE_UNKNOWN:display.getState());
  boolean shown=surface&&(!active||chip);
  String reason=SenseListeningPolicy.hiddenReason(shown,state,transitionAt<0?-1:SystemClock.uptimeMillis()-transitionAt,shade,hidden,locked);
  return new SenseListeningLease.Acknowledgement(admitted?uid:-1,surface,chip,active,state,reason);
 }

 private void publish(){for(SenseListeningChipView view:new ArrayList<>(views))view.render(active&&(!view.shadeSurface()||shadeEligible()));lease.now();}
 private void refreshCurrent(){try{refresh(audio.getActiveRecordingConfigurations());}catch(RuntimeException unavailable){uid=-1;active=false;publish();}}
 private int verifiedUid(){
  try{
   if(users.isUserSwitching()||!listenerPackage.equals(hostPackage+".sense")||!hostPackage.matches("[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+"))return -1;
   PackageManager pm=context.getPackageManager();PackageInfo pkg=pm.getPackageInfoAsUser(listenerPackage,PackageManager.GET_SIGNING_CERTIFICATES,0);
   ApplicationInfo app=pkg.applicationInfo;Signature[] signers=pkg.signingInfo==null?null:pkg.signingInfo.getApkContentsSigners();
   if(signers==null||signers.length!=1||!app.enabled)return -1;
   StringBuilder digest=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(signers[0].toByteArray()))digest.append(String.format(java.util.Locale.ROOT,"%02x",b&255));
   String[] packages=pm.getPackagesForUid(app.uid);
   boolean accepted=SenseListeningPolicy.identity(app.uid,users.getUserId(),UserHandle.getUserId(app.uid)==0,
    (app.flags&ApplicationInfo.FLAG_SYSTEM)!=0,(app.privateFlags&ApplicationInfo.PRIVATE_FLAG_PRIVILEGED)!=0,
    context.getString(R.string.config_senseListeningCertificateSha256),digest.toString(),
    pm.checkSignatures(listenerPackage,hostPackage)==PackageManager.SIGNATURE_MATCH,
    packages!=null&&packages.length==1&&listenerPackage.equals(packages[0]));
   return accepted?app.uid:-1;
  }catch(Exception unavailable){return -1;}
 }
 private void refresh(List<AudioRecordingConfiguration> configs){
  uid=verifiedUid();active=false;
  if(uid!=-1)for(AudioRecordingConfiguration config:configs)if(SenseListeningPolicy.recording(uid,config.getClientUid(),config.isClientSilenced())){active=true;break;}
  publish();
 }
 static boolean pause(){return instance!=null&&instance.pauseCurrent();}
 private boolean pauseCurrent(){
  refreshCurrent();if(!active||uid<0)return false;
  try{
   StatusBarNotification[] entries=notifications.getActiveNotifications();if(entries==null)return false;
   PendingIntent chosen=null;
   for(StatusBarNotification entry:entries){Notification notification=entry.getNotification();if(notification.actions==null)continue;
    for(Notification.Action action:notification.actions){PendingIntent token=action.actionIntent;if(token==null)continue;
     Intent target=token.getIntent();
     if(target==null||!(listenerPackage+".action.PAUSE").equals(target.getAction())
       ||!new ComponentName(listenerPackage,receiverClass).equals(target.getComponent())
       ||target.getData()!=null||target.getClipData()!=null||target.getExtras()!=null)continue;
     if(SenseListeningPolicy.pause(listenerPackage,uid,entry.getUid(),entry.getPackageName(),entry.getId(),notification.getChannelId(),token.getCreatorUid(),token.getCreatorPackage(),token.isImmutable(),token.isBroadcast(),action.isAuthenticationRequired(),action.getExtras().getString(listenerPackage+".SYSTEMUI_ACTION_V1"))){if(chosen!=null)return false;chosen=token;}
    }
   }
   if(chosen==null||verifiedUid()!=uid)return false;
   chosen.send(); // No fill-in Intent, extras, resume action, provider call or shared signer assumption.
   return true; // Keep indicator visible until AudioManager confirms recording has stopped.
  }catch(Exception unavailable){return false;}
 }
}
