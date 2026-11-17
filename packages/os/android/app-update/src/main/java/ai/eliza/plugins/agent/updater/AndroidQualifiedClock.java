package ai.eliza.plugins.agent.updater;
import ai.eliza.plugins.agent.runtime.AndroidRuntimeDirectories;

import android.content.Context;
import android.os.SystemClock;
import android.provider.Settings;
import java.io.*;
import java.nio.file.Path;

/** Adapter for a qualified native time authority. No authority/default policy is
 * enabled here. A process cannot survive reboot, so its boot identity is captured
 * once; each read uses Android elapsedRealtime, including device suspend. */
public class AndroidQualifiedClock {
 private final QualifiedClockAnchor anchor;private final String boot;
 public AndroidQualifiedClock(Context context,Path directory,QualifiedClockAnchor.Policy policy)throws Exception {
  int count=Settings.Global.getInt(context.getContentResolver(),Settings.Global.BOOT_COUNT);
  if(count<0)throw new IOException("Boot identity unavailable");boot="android-boot-"+count;
  anchor=new QualifiedClockAnchor(directory,policy,AndroidRuntimeDirectories::syncRuntimeDirectory);
 }
 public static void initializeForProvisioning(Path directory)throws IOException {
  QualifiedClockAnchor.initialize(directory,AndroidRuntimeDirectories::syncRuntimeDirectory);
 }
 // The native authority must authenticate evidence and ensure the sample's
 // elapsed observation belongs to this boot before invoking this method.
 public void acceptAuthenticated(String observationBoot,String evidence,long observedElapsed,long lower,long upper)throws IOException {
  anchor.acceptAuthenticated(new QualifiedClockAnchor.Sample(observationBoot,evidence,observedElapsed,lower,upper),boot,SystemClock.elapsedRealtime());
 }
 public String bootIdentity(){return boot;}
 public QualifiedClockAnchor.Interval readInterval()throws IOException {
  return anchor.read(boot,SystemClock.elapsedRealtime());
 }
}
