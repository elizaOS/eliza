package ai.eliza.sense;
import com.android.systemui.privacy.SenseListeningPolicy;
public final class ListenerSystemUiPolicyTest {
 static final String CERT="a".repeat(64),PKG="ai.eliza.sense";
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 static boolean identity(int uid,int user,String expected,String actual,boolean match,boolean sole){return SenseListeningPolicy.identity(uid,user,true,true,true,expected,actual,match,sole);}
 static boolean pause(int uid,int notice,int creator,String pkg,boolean immutable,boolean broadcast,boolean auth,String marker){return SenseListeningPolicy.pause(PKG,uid,notice,PKG,1,"listening-indicator",creator,pkg,immutable,broadcast,auth,marker);}
 public static void main(String[] args){
  check(identity(10042,0,CERT,CERT,true,true),"exact image identity");
  check(!identity(10042,10,CERT,CERT,true,true),"secondary foreground user");
  check(!identity(110042,0,CERT,CERT,true,true),"secondary UID");
  check(!identity(10042,0,"",CERT,true,true),"no configured signer");
  check(!identity(99000,0,CERT,CERT,true,true),"isolated UID never admitted as installed sense package");
  check(!identity(10042,0,CERT,"b".repeat(64),true,true),"substituted signer");
  check(!identity(10042,0,CERT,CERT,false,true),"Alpha signature mismatch");
  check(!identity(10042,0,CERT,CERT,true,false),"shared UID ambiguity");
  check(SenseListeningPolicy.recording(10042,10042,false),"unsilenced matching capture");
  check(!SenseListeningPolicy.recording(10042,10042,true),"silenced capture");
  check(!SenseListeningPolicy.recording(10042,99001,false),"unmapped isolated capture");
  check(!SenseListeningPolicy.recording(-1,-1,false),"invalid identity");
  check(pause(10042,10042,10042,PKG,true,true,false,SenseListeningPolicy.PAUSE),"immutable pause token");
  check(!pause(10042,10042,10043,PKG,true,true,false,SenseListeningPolicy.PAUSE),"wrong token owner");
  check(!pause(10042,10043,10042,PKG,true,true,false,SenseListeningPolicy.PAUSE),"wrong notification owner");
  check(!pause(10042,10042,10042,"other",true,true,false,SenseListeningPolicy.PAUSE),"wrong creator package");
  check(!pause(10042,10042,10042,PKG,false,true,false,SenseListeningPolicy.PAUSE),"mutable token");
  check(!pause(10042,10042,10042,PKG,true,false,false,SenseListeningPolicy.PAUSE),"not broadcast");
  check(!pause(10042,10042,10042,PKG,true,true,true,SenseListeningPolicy.PAUSE),"unlock-requiring action");
  check(!pause(10042,10042,10042,PKG,true,true,false,"resume"),"resume marker");
  check(ListenerActionContract.PAUSE.equals(ListenerActionContract.marker(PKG+".action.PAUSE")),"only pause advertised");
  for(String action:new String[]{null,"",PKG+".action.RESUME",PKG+".action.STOP",PKG+".action.DISMISSED"})check(ListenerActionContract.marker(action)==null,"never advertise another action");
  check(ListenerActionContract.KEY.equals(PKG+".SYSTEMUI_ACTION_V1"),"producer consumer contract");
  // ---- lease visibility measurement ----
  check(SenseListeningPolicy.effectivelyVisible(true,true,true,true,1f,100,100),"attached, shown and on screen");
  check(!SenseListeningPolicy.effectivelyVisible(false,true,true,true,1f,100,100),"detached view");
  check(!SenseListeningPolicy.effectivelyVisible(true,false,true,true,1f,100,100),"window hidden");
  check(!SenseListeningPolicy.effectivelyVisible(true,true,false,true,1f,100,100),"an ancestor is hidden");
  check(!SenseListeningPolicy.effectivelyVisible(true,true,true,false,1f,100,100),"aggregated visibility false");
  check(!SenseListeningPolicy.effectivelyVisible(true,true,true,true,0.2f,100,100),"faded out");
  check(!SenseListeningPolicy.effectivelyVisible(true,true,true,true,1f,89,100),"mostly clipped off screen");
  check(SenseListeningPolicy.effectivelyVisible(true,true,true,true,1f,90,100),"burn-in shift within tolerance");
  check(!SenseListeningPolicy.effectivelyVisible(true,true,true,true,1f,0,0)&&!SenseListeningPolicy.effectivelyVisible(true,true,true,true,1f,200,100),"empty or inconsistent geometry");
  check(SenseListeningPolicy.leaseTarget(PKG,10042,PKG,10042),"admitted listener provider");
  check(!SenseListeningPolicy.leaseTarget(PKG,10042,"com.example",10042)&&!SenseListeningPolicy.leaseTarget(PKG,10042,PKG,10043)&&!SenseListeningPolicy.leaseTarget(PKG,-1,PKG,-1),"never another provider");
  check(SenseListeningPolicy.chipAcknowledged(true,true)&&!SenseListeningPolicy.chipAcknowledged(false,true)&&!SenseListeningPolicy.chipAcknowledged(true,false),"chip acknowledged only with SystemUI's own recording observation");
  // ---- display, keyguard/AOD, shade and immersive ----
  check(SenseListeningPolicy.display(2).equals("on")&&SenseListeningPolicy.display(6).equals("on"),"display on");
  check(SenseListeningPolicy.display(3).equals("doze")&&SenseListeningPolicy.display(4).equals("doze"),"AOD");
  check(SenseListeningPolicy.display(1).equals("off"),"display off");
  for(int state:new int[]{0,5,7,-1})check(SenseListeningPolicy.display(state).equals("unknown"),"unknown: "+state);
  check(SenseListeningPolicy.hiddenReason(true,"on",-1,true,true,false).equals("none"),"shown needs no reason");
  check(SenseListeningPolicy.hiddenReason(false,"off",-1,false,false,false).equals("display_off"),"display off");
  check(SenseListeningPolicy.hiddenReason(false,"doze",-1,false,false,true).equals("aod"),"AOD not showing the chip");
  check(SenseListeningPolicy.hiddenReason(false,"on",999,true,true,false).equals("transition"),"within the debounce");
  check(SenseListeningPolicy.hiddenReason(false,"on",1000,false,false,false).equals("none"),"after the debounce nothing explains it");
  check(SenseListeningPolicy.hiddenReason(false,"on",-1,true,false,false).equals("shade"),"shade");
  check(SenseListeningPolicy.hiddenReason(false,"on",-1,false,true,false).equals("fullscreen"),"immersive");
  check(SenseListeningPolicy.hiddenReason(false,"on",-1,false,true,true).equals("none"),"immersive does not explain a hidden lock screen");
  check(SenseListeningPolicy.hiddenReason(false,"unknown",-1,false,false,false).equals("none"),"unknown display has no reason");
  check(SenseListeningPolicy.keyguardCounts(true,true,false),"lock screen / AOD chip");
  check(!SenseListeningPolicy.keyguardCounts(true,false,false),"keyguard chip after unlock does not count");
  check(!SenseListeningPolicy.keyguardCounts(true,true,true),"shade covers the lock-screen chip");
  check(SenseListeningPolicy.statusBarCounts(true,false,false,false),"unlocked status bar");
  check(!SenseListeningPolicy.statusBarCounts(true,true,false,false),"status-bar chip does not count on the keyguard");
  check(!SenseListeningPolicy.statusBarCounts(true,false,true,false),"expanded shade covers the status bar");
  check(!SenseListeningPolicy.statusBarCounts(true,false,false,true),"immersive app hid the status bar");
  check(SenseListeningPolicy.statusBarHidden(0,1,false)&&!SenseListeningPolicy.statusBarHidden(0,1,true)&&!SenseListeningPolicy.statusBarHidden(1,1,false),"immersive, transient reveal, normal");

  System.out.println("PASS listener SystemUI policy: identity, recording, pause-only capability, lease visibility, display/shade/immersive");
 }
}
