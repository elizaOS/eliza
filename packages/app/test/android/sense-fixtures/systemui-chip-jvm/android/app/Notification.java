package android.app;
import android.os.Bundle;
public class Notification {
 public static final int FLAG_ONGOING_EVENT=0x2;
 public int flags;
 public Action[] actions;
 public String getChannelId(){return null;}
 public static class Action {
  public PendingIntent actionIntent;
  public boolean isAuthenticationRequired(){return false;}
  public Bundle getExtras(){return new Bundle();}
 }
}
