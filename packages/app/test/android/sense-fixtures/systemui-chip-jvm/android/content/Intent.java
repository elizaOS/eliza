package android.content;
import android.net.Uri;
import android.os.Bundle;
public class Intent {
 public static final String ACTION_PACKAGE_ADDED="android.intent.action.PACKAGE_ADDED",ACTION_PACKAGE_REMOVED="android.intent.action.PACKAGE_REMOVED",ACTION_PACKAGE_REPLACED="android.intent.action.PACKAGE_REPLACED";
 public String getAction(){return null;}
 public ComponentName getComponent(){return null;}
 public Uri getData(){return null;}
 public ClipData getClipData(){return null;}
 public Bundle getExtras(){return null;}
}
