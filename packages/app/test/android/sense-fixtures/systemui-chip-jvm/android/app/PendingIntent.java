package android.app;
import android.content.Intent;
public final class PendingIntent {
 public static class CanceledException extends Exception {}
 /** @hide in AOSP; available to platform-signed SystemUI. */
 public Intent getIntent(){return null;}
 public int getCreatorUid(){return -1;}
 public String getCreatorPackage(){return null;}
 public boolean isImmutable(){return false;}
 public boolean isBroadcast(){return false;}
 public void send()throws CanceledException{}
}
