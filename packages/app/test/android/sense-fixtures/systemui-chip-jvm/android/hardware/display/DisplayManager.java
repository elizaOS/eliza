package android.hardware.display;
import android.os.Handler;
import android.view.Display;
public class DisplayManager {
 public interface DisplayListener { void onDisplayAdded(int displayId); void onDisplayRemoved(int displayId); void onDisplayChanged(int displayId); }
 public Display getDisplay(int displayId){return null;}
 public void registerDisplayListener(DisplayListener listener,Handler handler){}
}
