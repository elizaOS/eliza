package com.android.systemui.privacy;

/** Platform-derived facts only. No transcript, PCM, listener self-report or app-supplied UID. */
public final class SenseListeningPolicy {
 public static final String PAUSE="pause-until-resumed";
 public static boolean identity(int uid,int foregroundUser,boolean primaryUser,boolean systemApp,
   boolean privileged,String expectedSigner,String actualSigner,boolean matchesHost,boolean solePackage){
  return foregroundUser==0&&primaryUser&&uid>=10000&&uid<20000&&systemApp&&privileged
   &&expectedSigner!=null&&expectedSigner.matches("[a-f0-9]{64}")&&expectedSigner.equals(actualSigner)
   &&matchesHost&&solePackage;
 }
 public static boolean recording(int admittedUid,int recordingUid,boolean silenced){
  return admittedUid>=10000&&admittedUid<20000&&admittedUid==recordingUid&&!silenced;
 }
 public static boolean pause(String expectedPackage,int admittedUid,int notificationUid,String notificationPackage,
   int notificationId,String channel,int creatorUid,String creatorPackage,boolean immutable,
   boolean broadcast,boolean requiresUnlock,String marker){
  return admittedUid>=10000&&admittedUid<20000&&admittedUid==notificationUid&&admittedUid==creatorUid
   &&expectedPackage.equals(notificationPackage)&&expectedPackage.equals(creatorPackage)&&notificationId==1
   &&"listening-indicator".equals(channel)&&immutable&&broadcast&&!requiresUnlock&&PAUSE.equals(marker);
 }
 // Indicator health lease (docs/aosp-listening-chip.md); mirrors the listener's IndicatorLease contract.
 public static final String LEASE_ACQUIRE="acquire",LEASE_RENEW="renew",LEASE_REVOKE="revoke";
 public static final String KEY_TOKEN="token",KEY_GENERATION="generation",KEY_ACCEPTED="accepted",
  KEY_SURFACE="surfaceVisible",KEY_CHIP="chipVisible",KEY_RECORDING="recordingObserved",KEY_DISPLAY="display",KEY_REASON="hiddenReason";
 public static final String DISPLAY_ON="on",DISPLAY_DOZE="doze",DISPLAY_OFF="off",DISPLAY_UNKNOWN="unknown";
 /** Why the indicator is not shown, as SystemUI positively knows it. NONE: shown, or no known reason (unexplained). */
 public static final String REASON_NONE="none",REASON_DISPLAY_OFF="display_off",REASON_AOD="aod",REASON_FULLSCREEN="fullscreen",
  REASON_SHADE="shade",REASON_TRANSITION="transition";
 /** A hidden report within this time of a reported keyguard, doze or display-state change is a transition. */
 public static final long TRANSITION_DEBOUNCE_MS=1_000;
 public static final long LEASE_RENEW_MS=1_000;
 /**
  * Default display state (android.view.Display.STATE_*): ON 2 and ON_SUSPEND 6 are on; DOZE 3 and
  * DOZE_SUSPEND 4 are AOD; OFF 1 is off; UNKNOWN 0, VR 5 and anything else are unknown (the
  * listener pauses only if it sees the screen off itself, otherwise it stops).
  */
 public static String display(int state){
  switch(state){case 2:case 6:return DISPLAY_ON;case 3:case 4:return DISPLAY_DOZE;case 1:return DISPLAY_OFF;default:return DISPLAY_UNKNOWN;}
 }
 /**
  * The explanation SystemUI attaches when the indicator is not shown ({@code shown}: surface
  * visible and, while recording, the chip too). In order: display off; AOD not showing it; a report
  * within {@link #TRANSITION_DEBOUNCE_MS} of a keyguard/doze/display change; the expanded shade
  * without its measured indicator; an app hiding the unlocked status bar. Anything else (for
  * example a detached or faded chip) has no reason and the listener treats it as a loss.
  */
 public static String hiddenReason(boolean shown,String display,long sinceTransitionMs,boolean shadeExpanded,boolean statusBarHidden,boolean keyguardShowing){
  if(shown)return REASON_NONE;
  if(DISPLAY_OFF.equals(display))return REASON_DISPLAY_OFF;
  if(DISPLAY_DOZE.equals(display))return REASON_AOD;
  if(sinceTransitionMs>=0&&sinceTransitionMs<TRANSITION_DEBOUNCE_MS)return REASON_TRANSITION;
  if(shadeExpanded)return REASON_SHADE;
  if(statusBarHidden&&!keyguardShowing)return REASON_FULLSCREEN;
  return REASON_NONE;
 }
 /**
  * The status-bar chip counts only while the keyguard is not showing, the shade is collapsed and
  * no app has hidden the status bar (immersive) without a transient reveal. SystemUI positively
  * reports each of those; a covered or hidden status bar is not visible.
  */
 public static boolean statusBarCounts(boolean measured,boolean keyguardShowing,boolean shadeExpanded,boolean statusBarHidden){
  return measured&&!keyguardShowing&&!shadeExpanded&&!statusBarHidden;
 }
 /** The lock-screen/AOD chip (keyguard indication area) counts while the keyguard shows and the shade is collapsed. */
 public static boolean keyguardCounts(boolean measured,boolean keyguardShowing,boolean shadeExpanded){
  return measured&&keyguardShowing&&!shadeExpanded;
 }
 /** An app requested the status bar hidden (WindowInsets.Type.statusBars() not requested visible) and it is not transiently shown. */
 public static boolean statusBarHidden(int requestedVisibleTypes,int statusBarsType,boolean transientShown){
  return statusBarsType!=0&&(requestedVisibleTypes&statusBarsType)==0&&!transientShown;
 }
 /** Below this effective alpha or visible fraction a surface does not count as shown. */
 public static final float MIN_ALPHA=0.5f;
 public static final int MIN_VISIBLE_PERCENT=90;
 /**
  * Effective on-screen visibility of one SystemUI view, measured by SystemUI from its own view
  * tree: attached, its window visible, shown through every ancestor, aggregated-visible, mostly
  * opaque along the ancestor chain and almost entirely inside the visible screen area.
  */
 public static boolean effectivelyVisible(boolean attached,boolean windowVisible,boolean shown,boolean aggregated,
   float effectiveAlpha,long visibleArea,long area){
  return attached&&windowVisible&&shown&&aggregated&&effectiveAlpha>=MIN_ALPHA&&area>0&&visibleArea>0
   &&visibleArea<=area&&visibleArea*100>=area*MIN_VISIBLE_PERCENT;
 }
 /** Acknowledgements go only to the lease provider of the already admitted listener UID. */
 public static boolean leaseTarget(String expectedPackage,int admittedUid,String providerPackage,int providerUid){
  return admittedUid>=10000&&admittedUid<20000&&expectedPackage.equals(providerPackage)&&providerUid==admittedUid;
 }
 /** The chip may be acknowledged as visible only while SystemUI itself observes the recording. */
 public static boolean chipAcknowledged(boolean recordingObserved,boolean anyChipVisible){return recordingObserved&&anyChipVisible;}
 private SenseListeningPolicy(){}
}
