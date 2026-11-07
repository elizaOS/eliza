package com.android.systemui.privacy;

import ai.eliza.sense.IndicatorLease;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.ProviderInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Host-JVM run of the prepared SystemUI lease client (SenseListeningLease) against the listener's
 * real IndicatorLease rules, through hand-written Android stubs. The fake provider below stands in
 * for IndicatorLeaseProvider's binder transport; nothing here runs SystemUI or Android.
 */
public final class SystemUiLeaseClientTest {
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 static final int UID=10_042;static final long BOOT=3;

 static final class Listener {
  final IndicatorLease lease=new IndicatorLease();final Handler clock;
  final List<String> calls=new ArrayList<>();final List<Set<String>> keys=new ArrayList<>();
  IBinder token;long generation=-1;
  Listener(Handler clock){this.clock=clock;}
  Bundle call(String method,Bundle extras){
   calls.add(method);keys.add(new java.util.TreeSet<>(extras.keySet()));
   Bundle out=new Bundle();
   if(IndicatorLease.ACQUIRE.equals(method)){token=extras.getBinder(IndicatorLease.KEY_TOKEN);check(token!=null,"token");generation=lease.acquire(BOOT);out.putLong(IndicatorLease.KEY_GENERATION,generation);}
   else if(IndicatorLease.RENEW.equals(method))out.putBoolean(IndicatorLease.KEY_ACCEPTED,lease.renew(extras.getLong(IndicatorLease.KEY_GENERATION,-1),clock.now,BOOT,
    extras.getBoolean(IndicatorLease.KEY_SURFACE,false),extras.getBoolean(IndicatorLease.KEY_CHIP,false),extras.getBoolean(IndicatorLease.KEY_RECORDING,false),
    extras.getString(IndicatorLease.KEY_DISPLAY),extras.getString(IndicatorLease.KEY_REASON)));
   else if(IndicatorLease.REVOKE.equals(method))lease.revoke(extras.getLong(IndicatorLease.KEY_GENERATION,-1));
   else throw new IllegalArgumentException(method);
   return out;
  }
  /** SystemUI's process died: the listener's linkToDeath recipient fires. */
  void systemUiDied(){lease.binderDied(generation);}
  IndicatorLease.Loss verdict(boolean attribution){return lease.verdict(clock.now,BOOT,attribution);}
 }

 static int uid=UID;static boolean surface=true,chip=false,recording=false;static String display=SenseListeningPolicy.DISPLAY_ON,reason=SenseListeningPolicy.REASON_NONE;

 static ProviderInfo provider(String pkg,int owner){ProviderInfo info=new ProviderInfo();info.packageName=pkg;info.applicationInfo=new ApplicationInfo();info.applicationInfo.uid=owner;return info;}

 public static void main(String[] args){
  check("ai.eliza.sense.indicator".equals("ai.eliza.sense.indicator")&&SenseListeningPolicy.LEASE_ACQUIRE.equals(IndicatorLease.ACQUIRE)
   &&SenseListeningPolicy.LEASE_RENEW.equals(IndicatorLease.RENEW)&&SenseListeningPolicy.LEASE_REVOKE.equals(IndicatorLease.REVOKE)
   &&SenseListeningPolicy.KEY_TOKEN.equals(IndicatorLease.KEY_TOKEN)&&SenseListeningPolicy.KEY_GENERATION.equals(IndicatorLease.KEY_GENERATION)
   &&SenseListeningPolicy.KEY_ACCEPTED.equals(IndicatorLease.KEY_ACCEPTED)&&SenseListeningPolicy.KEY_SURFACE.equals(IndicatorLease.KEY_SURFACE)
   &&SenseListeningPolicy.KEY_CHIP.equals(IndicatorLease.KEY_CHIP)&&SenseListeningPolicy.KEY_RECORDING.equals(IndicatorLease.KEY_RECORDING)
   &&SenseListeningPolicy.KEY_DISPLAY.equals(IndicatorLease.KEY_DISPLAY)&&SenseListeningPolicy.DISPLAY_ON.equals(IndicatorLease.DISPLAY_ON)
   &&SenseListeningPolicy.DISPLAY_DOZE.equals(IndicatorLease.DISPLAY_DOZE)&&SenseListeningPolicy.DISPLAY_OFF.equals(IndicatorLease.DISPLAY_OFF)
   &&SenseListeningPolicy.KEY_REASON.equals(IndicatorLease.KEY_REASON)&&SenseListeningPolicy.REASON_NONE.equals(IndicatorLease.REASON_NONE)
   &&SenseListeningPolicy.REASON_DISPLAY_OFF.equals(IndicatorLease.REASON_DISPLAY_OFF)&&SenseListeningPolicy.REASON_AOD.equals(IndicatorLease.REASON_AOD)
   &&SenseListeningPolicy.REASON_FULLSCREEN.equals(IndicatorLease.REASON_FULLSCREEN)&&SenseListeningPolicy.REASON_SHADE.equals(IndicatorLease.REASON_SHADE)
   &&SenseListeningPolicy.REASON_TRANSITION.equals(IndicatorLease.REASON_TRANSITION)
   &&SenseListeningPolicy.LEASE_RENEW_MS==IndicatorLease.RENEW_MS&&SenseListeningPolicy.LEASE_RENEW_MS*2<IndicatorLease.TTL_MS,"SystemUI and listener share one lease contract");
  Handler main=new Handler();main.now=1_000_000;
  Context context=new Context();Listener listener=new Listener(main);
  context.resolver.handler=(uri,method,arg,extras)->{check(("content://"+"ai.eliza.sense.indicator").equals(uri.toString()),"only the lease authority");return listener.call(method,extras);};
  context.packages.provider=provider("ai.eliza.sense",UID);
  SenseListeningLease client=new SenseListeningLease(context,main,Runnable::run,()->new SenseListeningLease.Acknowledgement(uid,surface,chip,recording,display,reason),"ai.eliza.sense");
  client.now();main.advanceTo(main.now);
  check(listener.calls.isEmpty(),"nothing is sent before start");
  client.start();main.advanceTo(main.now);
  check(listener.calls.equals(List.of("acquire","renew")),"acquire then acknowledge: "+listener.calls);
  check(listener.keys.get(0).equals(Set.of(IndicatorLease.KEY_TOKEN)),"acquire carries only the death token");
  check(listener.keys.get(1).equals(Set.of(IndicatorLease.KEY_GENERATION,IndicatorLease.KEY_SURFACE,IndicatorLease.KEY_CHIP,IndicatorLease.KEY_RECORDING,IndicatorLease.KEY_DISPLAY,IndicatorLease.KEY_REASON)),"acknowledgements carry visibility facts only");
  check(listener.verdict(false)==IndicatorLease.Loss.NONE,"visible surface admits a start");
  // ---- renewal ----
  long start=main.now;main.advanceTo(start+30_000);
  check(listener.verdict(false)==IndicatorLease.Loss.NONE,"renewals keep the lease alive");
  check(listener.calls.stream().filter("renew"::equals).count()>=30&&listener.calls.stream().filter("acquire"::equals).count()==1,"one generation, renewed every second");
  // ---- recording shown, then the chip hidden ----
  recording=true;chip=true;client.now();main.advanceTo(main.now);
  check(listener.verdict(true)==IndicatorLease.Loss.NONE,"SystemUI observes and shows the recording");
  chip=false;client.now();main.advanceTo(main.now);
  check(listener.verdict(false)==IndicatorLease.Loss.CHIP_HIDDEN,"a hidden chip is reported at once, not at the next renewal");
  recording=false;chip=true;client.now();main.advanceTo(main.now);
  check(listener.verdict(true)==IndicatorLease.Loss.UNATTRIBUTED,"a visible chip without SystemUI's own recording observation is never acknowledged");
  // ---- screen off: AOD keeps the lease, a dark display pauses and a visible surface resumes ----
  recording=true;chip=true;display=SenseListeningPolicy.display(3);client.now();main.advanceTo(main.now+10_000);
  check(listener.verdict(true)==IndicatorLease.Loss.NONE,"AOD (doze) showing the chip keeps the lease");
  display=SenseListeningPolicy.display(1);surface=false;chip=false;client.now();main.advanceTo(main.now);
  check(listener.verdict(false)==IndicatorLease.Loss.DISPLAY_OFF,"a dark display is reported at once as a pause, not a loss");
  main.advanceTo(main.now+30_000);
  check(listener.verdict(false)==IndicatorLease.Loss.DISPLAY_OFF,"SystemUI keeps the lease alive while the display is off");
  display=SenseListeningPolicy.display(2);surface=true;chip=true;client.now();main.advanceTo(main.now);
  check(listener.verdict(true)==IndicatorLease.Loss.NONE,"the lock screen shown again resumes the lease");
  // ---- explained hidden indicator: fullscreen and shade pause, then resume ----
  surface=false;chip=false;reason=SenseListeningPolicy.REASON_FULLSCREEN;client.now();main.advanceTo(main.now+10_000);
  check(listener.verdict(true)==IndicatorLease.Loss.FULLSCREEN,"immersive is reported as an explained pause and keeps the lease alive");
  reason=SenseListeningPolicy.REASON_SHADE;client.now();main.advanceTo(main.now);
  check(listener.verdict(true)==IndicatorLease.Loss.SHADE,"expanded shade without the notification");
  surface=true;chip=true;reason=SenseListeningPolicy.REASON_NONE;client.now();main.advanceTo(main.now);
  check(listener.verdict(true)==IndicatorLease.Loss.NONE,"visible again");
  // ---- hidden/detached surface ----
  recording=true;chip=true;client.now();main.advanceTo(main.now);check(listener.verdict(true)==IndicatorLease.Loss.NONE,"restored");
  surface=false;chip=false;client.now();main.advanceTo(main.now);
  check(listener.verdict(false)==IndicatorLease.Loss.SURFACE_HIDDEN,"a detached or hidden surface is acknowledged as hidden");
  surface=true;chip=true;client.now();main.advanceTo(main.now);
  // ---- SystemUI hangs: no renewals, the lease expires ----
  long hung=main.now;main.now=hung+IndicatorLease.TTL_MS; // main thread blocked: no ticks run
  check(listener.verdict(true)==IndicatorLease.Loss.EXPIRED,"a hung SystemUI loses the lease within the TTL");
  long expired=listener.generation;main.advanceTo(main.now+10);
  check(listener.verdict(false)==IndicatorLease.Loss.EXPIRED,"the late renewal of the expired generation is refused");
  main.advanceTo(main.now+IndicatorLease.RENEW_MS);
  check(listener.verdict(false)==IndicatorLease.Loss.NONE&&listener.generation>expired&&listener.calls.get(listener.calls.size()-2).equals("acquire"),"SystemUI then acquires a new generation");
  // ---- SystemUI death ----
  long before=listener.generation;listener.systemUiDied();
  check(listener.verdict(false)==IndicatorLease.Loss.BINDER_DIED,"binder death ends the lease immediately");
  main.advanceTo(main.now+IndicatorLease.RENEW_MS);
  main.advanceTo(main.now+IndicatorLease.RENEW_MS);
  check(listener.generation>before,"the next renewal on the dead generation is refused and a new one acquired");
  // ---- identity loss and provider substitution ----
  uid=-1;client.now();main.advanceTo(main.now);
  check(listener.calls.get(listener.calls.size()-1).equals("revoke")&&listener.verdict(false)==IndicatorLease.Loss.REVOKED,"unverified listener identity revokes");
  int count=listener.calls.size();main.advanceTo(main.now+5*IndicatorLease.RENEW_MS);
  check(listener.calls.size()==count,"nothing is sent while identity is unverified");
  uid=UID;context.packages.provider=provider("com.example.impostor",UID);main.advanceTo(main.now+3*IndicatorLease.RENEW_MS);
  check(listener.calls.size()==count,"acknowledgements never go to another package's provider");
  context.packages.provider=provider("ai.eliza.sense",UID+1);main.advanceTo(main.now+3*IndicatorLease.RENEW_MS);
  check(listener.calls.size()==count,"nor to a provider under another UID");
  context.packages.provider=null;main.advanceTo(main.now+3*IndicatorLease.RENEW_MS);
  check(listener.calls.size()==count,"nor when no provider resolves");
  // ---- an unavailable provider fails closed ----
  context.packages.provider=provider("ai.eliza.sense",UID);main.advanceTo(main.now+IndicatorLease.RENEW_MS);
  check(listener.verdict(true)==IndicatorLease.Loss.NONE,"recovers with a new generation");
  context.resolver.handler=(uri,method,arg,extras)->{throw new IllegalStateException("listener process gone");};
  main.advanceTo(main.now+IndicatorLease.TTL_MS);
  check(listener.verdict(false)==IndicatorLease.Loss.EXPIRED,"undeliverable acknowledgements let the lease expire");
  System.out.println("PASS SystemUI lease client: contract, renewal, hidden chip/surface, hang, death, identity");
 }
}
