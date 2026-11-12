package ai.eliza.plugins.passwords;

import android.os.Looper;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Process-wide signal that a secret surface is up: the unlock prompt, the editor and its
 * questions, a revealed password, or the fill or save screen. It becomes visible before the first
 * surface draws and hidden after the last one closes, so a host can stop capture and speech first.
 * Listeners run on the main thread, inside the call that opens or closes the surface, so they must
 * be quick, must not throw and must not open a surface. Native only; page script cannot observe or
 * change it.
 */
public final class PasswordSurfaces {
  private PasswordSurfaces() {}
  public interface Listener { void onSecretSurfaceChanged(boolean visible); }
  private static final List<Listener> LISTENERS = new CopyOnWriteArrayList<>();
  private static volatile int open;

  public static void addListener(Listener listener) { LISTENERS.add(listener); }
  public static void removeListener(Listener listener) { LISTENERS.remove(listener); }
  public static boolean visible() { return open > 0; }

  /** One surface from before it draws until {@link #close}. Closing again does nothing. */
  static final class Hold {
    private boolean closed;
    void close() {
      if (closed) return;
      closed = true;
      if (--open == 0) changed(false);
    }
  }

  static Hold open() {
    if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Secret surfaces open on the main thread");
    if (open++ == 0) changed(true);
    return new Hold();
  }

  private static void changed(boolean visible) { for (Listener listener : LISTENERS) listener.onSecretSurfaceChanged(visible); }
}
