package ai.eliza.plugins.agent.updater.policy;

import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;

/** The local installation window. This is user comfort only: it reads the
 * device's local wall clock and time zone, which nobody authenticates, and it
 * never authorizes work on its own; every activation gate still applies.
 * Window instants are resolved in the caller's zone, so a daylight-saving gap
 * moves a nonexistent 02:00 forward instead of skipping the night. */
public final class ComfortWindow {
 private ComfortWindow(){}
 public enum State {
  /** Inside the preferred overnight window. */
  OVERNIGHT,
  /** Outside it, after enough missed windows: a safe daytime opportunity. */
  DAYTIME_FALLBACK,
  /** Outside it; wait for the next window. */
  CLOSED
 }

 public static State state(OtaPolicy policy,LocalTime now,int missedWindows){
  if(inWindow(policy,now))return State.OVERNIGHT;
  return missedWindows>=policy.missedWindowsBeforeDaytime?State.DAYTIME_FALLBACK:State.CLOSED;
 }

 static boolean inWindow(OtaPolicy policy,LocalTime now){
  int minute=now.getHour()*60+now.getMinute();
  return policy.windowStartMinute<policy.windowEndMinute
   ?minute>=policy.windowStartMinute&&minute<policy.windowEndMinute
   :minute>=policy.windowStartMinute||minute<policy.windowEndMinute;
 }

 private static ZonedDateTime at(LocalDate date,int minute,ZonedDateTime zone){
  return ZonedDateTime.of(date,LocalTime.of(minute/60,minute%60),zone.getZone());
 }

 /** How many windows ended in (from, to], capped at cap. Zero if the local clock went backwards. */
 public static int windowsEnded(OtaPolicy policy,ZonedDateTime from,ZonedDateTime to,int cap){
  from=from.withZoneSameInstant(to.getZone());
  if(!to.isAfter(from))return 0;
  // At least cap+2 whole days hold more than cap window ends, even across DST.
  if(Duration.between(from,to).toDays()>cap+1L)return cap;
  int count=0;
  for(LocalDate day=from.toLocalDate().minusDays(1);!day.isAfter(to.toLocalDate().plusDays(1));day=day.plusDays(1)){
   ZonedDateTime end=at(day,policy.windowEndMinute,from);
   if(end.isAfter(from)&&!end.isAfter(to))count++;
  }
  return Math.min(count,cap);
 }

 /** Time until the window next opens; zero while it is open. */
 public static Duration untilOpen(OtaPolicy policy,ZonedDateTime now){
  if(inWindow(policy,now.toLocalTime()))return Duration.ZERO;
  ZonedDateTime start=at(now.toLocalDate(),policy.windowStartMinute,now);
  if(!start.isAfter(now))start=at(now.toLocalDate().plusDays(1),policy.windowStartMinute,now);
  return Duration.between(now,start);
 }
}
