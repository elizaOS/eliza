package ai.eliza.plugins.passwords;

import ai.eliza.plugins.securestore.nativeonly.NativeDeadlineTimer;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import android.view.WindowManager;
import android.widget.TextView;
import java.util.UUID;

/**
 * The only native surfaces that display or export a secret. Both run on the main thread, are
 * user-initiated from the vault UI, and never pass the value back to the caller.
 */
public final class SecretSurfaces {
  private SecretSurfaces() {}
  static final long REVEAL_MILLIS = 30_000, CLIPBOARD_MILLIS = 45_000;
  private static AlertDialog current;
  private static PasswordSurfaces.Hold currentSurface;
  private static final NativeDeadlineTimer REVEAL_TIMER = new NativeDeadlineTimer();
  private static final Handler MAIN = new Handler(Looper.getMainLooper());

  /** FLAG_SECURE dialog; dismissed after {@link #REVEAL_MILLIS} or when the host stops. */
  static void reveal(Activity activity, String title, String secret) {
    TextView value = new TextView(activity);
    value.setText(secret);
    value.setTypeface(Typeface.MONOSPACE);
    value.setTextIsSelectable(false);
    value.setSaveEnabled(false); value.setSaveFromParentEnabled(false);
    value.setTextSize(20);
    int pad = PasswordSheet.dp(activity, 24);
    value.setPadding(pad, pad / 2, pad, 0);
    AlertDialog dialog = new AlertDialog.Builder(activity).setTitle(title).setView(value)
      .setPositiveButton(R.string.eliza_passwords_hide, (shown, which) -> shown.dismiss()).create();
    dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    PasswordSurfaces.Hold surface = PasswordSurfaces.open(); // Before an earlier reveal closes, so the surface stays up.
    dismiss();
    dialog.setOnDismissListener(closed -> { value.setText(""); surface.close(); if (current == closed) { current = null; currentSurface = null; REVEAL_TIMER.cancel(); } });
    current = dialog; currentSurface = surface;
    dialog.show();
    REVEAL_TIMER.after(REVEAL_MILLIS, SecretSurfaces::dismiss);
  }

  /** Native-only reuse for another protected credential; no secret is returned to a renderer.
   * The caller supplies its current foreground/unlocked owner guard and closes its own handle on
   * retirement. An old handle cannot close a later secret surface. */
  public static AutoCloseable revealOwned(Activity activity, String title, String secret,
      java.util.function.BooleanSupplier ownerCurrent) {
    if (Looper.myLooper() != Looper.getMainLooper() || !ownerCurrent.getAsBoolean())
      throw new SecurityException("Credential reveal owner unavailable");
    reveal(activity, title, secret);
    AlertDialog owned = current;
    long started = android.os.SystemClock.elapsedRealtime();
    REVEAL_TIMER.watch(() -> {
      long elapsed = android.os.SystemClock.elapsedRealtime() - started;
      return ownerCurrent.getAsBoolean() && elapsed >= 0 && elapsed < REVEAL_MILLIS
          ? Math.min(250, REVEAL_MILLIS - elapsed) : 0;
    }, () -> { if (current == owned) dismiss(); });
    return () -> {
      Runnable close = () -> { if (current == owned) dismiss(); };
      if (Looper.myLooper() == Looper.getMainLooper()) close.run(); else MAIN.post(close);
    };
  }

  /** Hide, the timer and every host close end the surface here or in the dismiss listener, whichever is first. */
  static void dismiss() {
    REVEAL_TIMER.cancel();
    AlertDialog dialog = current; PasswordSurfaces.Hold surface = currentSurface; current = null; currentSurface = null;
    if (dialog != null && dialog.isShowing()) dialog.dismiss();
    if (surface != null) surface.close();
  }

  private static String clipLabel;
  private static long clipExpiresAt;

  /** Marks the clip sensitive (hidden from clipboard previews on Android 13+) and clears it after
   * {@link #CLIPBOARD_MILLIS}. When Android lets this app read the clip description (it has input
   * focus), a clip that is no longer ours is left alone. If Android hides the description,
   * defer clearing until resume; unknown ownership never authorizes deleting another clip. */
  static void copy(Activity activity, String secret) {
    ClipboardManager clipboard = activity.getSystemService(ClipboardManager.class);
    if (clipboard == null) throw new IllegalStateException("Clipboard unavailable");
    String label = "eliza-passwords-" + UUID.randomUUID();
    ClipData clip = ClipData.newPlainText(label, secret);
    PersistableBundle extras = new PersistableBundle();
    extras.putBoolean(Build.VERSION.SDK_INT >= 33 ? ClipDescription.EXTRA_IS_SENSITIVE : "android.content.extra.IS_SENSITIVE", true);
    clip.getDescription().setExtras(extras);
    clipboard.setPrimaryClip(clip);
    clipLabel = label; clipExpiresAt = android.os.SystemClock.elapsedRealtime() + CLIPBOARD_MILLIS;
    MAIN.postDelayed(() -> clearIfOurs(clipboard, label), CLIPBOARD_MILLIS);
  }

  static void clearIfOurs(ClipboardManager clipboard, String label) {
    if (!label.equals(clipLabel)) return; // Already cleared, or superseded by a newer copy.
    try {
      ClipDescription description = clipboard.getPrimaryClipDescription();
      if (description == null) return;
      boolean ours = label.contentEquals(description.getLabel() == null ? "" : description.getLabel());
      if (ours) clipboard.clearPrimaryClip();
    } catch (RuntimeException unavailable) { /* Retried on the next resume. */ return; }
    clipLabel = null;
  }

  /** Called on resume: runs a clear that came due while the timer could not (a frozen process). */
  static void resume(Activity activity) {
    String label = clipLabel;
    if (label == null || android.os.SystemClock.elapsedRealtime() < clipExpiresAt) return;
    ClipboardManager clipboard = activity.getSystemService(ClipboardManager.class);
    if (clipboard != null) MAIN.post(() -> clearIfOurs(clipboard, label));
  }
}
