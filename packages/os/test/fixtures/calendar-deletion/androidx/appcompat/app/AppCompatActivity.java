// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package androidx.appcompat.app;

public class AppCompatActivity extends android.content.Context {
  public boolean focused = true;
  private final androidx.lifecycle.Lifecycle lifecycle = new androidx.lifecycle.Lifecycle();
  public boolean isFinishing() { return false; }
  public boolean isDestroyed() { return false; }
  public boolean hasWindowFocus() { return focused; }
  public androidx.lifecycle.Lifecycle getLifecycle() { return lifecycle; }
  public void runOnUiThread(Runnable action) { throw new AssertionError("A native dialog was opened"); }
  public void startActivity(android.content.Intent intent) { throw new AssertionError("An activity was started"); }
}
