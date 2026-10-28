package android.content;
import android.content.pm.PackageManager;
import android.os.Handler;
public class Context {
 public static final int RECEIVER_NOT_EXPORTED=4;
 public android.content.res.Resources getResources(){return new android.content.res.Resources();}
 public final ContentResolver resolver=new ContentResolver();
 public final PackageManager packages=new PackageManager();
 public ContentResolver getContentResolver(){return resolver;}
 public PackageManager getPackageManager(){return packages;}
 public final String getString(int id){return "";}
 public Intent registerReceiver(BroadcastReceiver receiver,IntentFilter filter,String permission,Handler scheduler,int flags){return null;}
}
