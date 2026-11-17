package ai.eliza.sense;

import java.util.Arrays;

/**
 * A persistent system app is restarted by Android after every crash. Without a breaker a fault in
 * capture or speech loading would reopen the microphone in a loop. Each start while a capture
 * session was still marked open counts as an unclean exit; enough of them inside the window stop
 * listening until the user turns it back on. Pure Java; timestamps are wall-clock milliseconds.
 */
public final class CrashLoopBreaker {
 private CrashLoopBreaker(){}
 public static final int LIMIT=3;
 public static final long WINDOW_MS=10*60_000L;
 /** Bounded so a corrupted store cannot grow without limit. */
 public static final int KEEP=8;

 /** Unclean exits inside the window, newest last, with {@code now} appended when the last session did not close cleanly. */
 public static long[] onProcessStart(long[] previous,boolean sessionWasOpen,long now){
  long[] kept=prune(previous,now);
  if(!sessionWasOpen)return kept;
  long[] next=Arrays.copyOf(kept,kept.length+1);
  next[kept.length]=now;
  return next.length>KEEP?Arrays.copyOfRange(next,next.length-KEEP,next.length):next;
 }

 public static long[] prune(long[] previous,long now){
  if(previous==null)return new long[0];
  return Arrays.stream(previous).filter(time->time<=now&&now-time<WINDOW_MS).sorted().toArray();
 }

 /**
  * Whether an open-session marker found at process start is a crash. A shutdown, reboot or OTA
  * kills the process without a clean stop, so a marker written in a different boot is not counted,
  * nor is one written by a different install of this package (a package update also kills the
  * process). An unknown boot count ({@code <0}) is compared conservatively, as the same boot.
  */
 public static boolean uncleanExit(boolean sessionOpen,long markerBoot,long currentBoot,long markerInstall,long currentInstall){
  if(!sessionOpen)return false;
  if(markerBoot>=0&&currentBoot>=0&&markerBoot!=currentBoot)return false;
  return markerInstall==currentInstall;
 }

 public static boolean tripped(long[] exits,long now){return prune(exits,now).length>=LIMIT;}

 public static String encode(long[] exits){
  StringBuilder out=new StringBuilder();
  for(long time:exits==null?new long[0]:exits){if(out.length()>0)out.append(',');out.append(time);}
  return out.toString();
 }

 /** Unparseable entries are dropped; the store is never trusted to be well formed. */
 public static long[] decode(String text){
  if(text==null||text.isEmpty())return new long[0];
  return Arrays.stream(text.split(",",KEEP+1)).limit(KEEP).mapToLong(part->{try{return Long.parseLong(part.trim());}catch(NumberFormatException bad){return -1;}}).filter(time->time>=0).toArray();
 }
}
