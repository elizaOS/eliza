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
  private static volatile AlertDialog current, confirmation;
  private static PasswordSurfaces.Hold currentSurface;
  private static final NativeDeadlineTimer REVEAL_TIMER = new NativeDeadlineTimer();
  private static final Handler MAIN = new Handler(Looper.getMainLooper());

  static boolean confirm(Activity activity, int action, Runnable accept, Runnable cancel) {
    if (confirmation != null) return false;
    PasswordSurfaces.Hold hold = PasswordSurfaces.open();
    AlertDialog dialog = new AlertDialog.Builder(activity)
      .setTitle(action)
      .setNegativeButton(R.string.eliza_passwords_cancel, null)
      .setPositiveButton(action, null)
      .create();
    dialog.setOwnerActivity(activity);
    boolean[] accepted = { false };
    dialog.setOnDismissListener(ignored -> {
      if (confirmation == dialog) confirmation = null;
      hold.close();
      if (!accepted[0]) cancel.run();
    });
    confirmation = dialog;
    try {
      dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
      dialog.show();
      dialog.getButton(AlertDialog.BUTTON_POSITIVE).setFilterTouchesWhenObscured(true);
      dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
        if (confirmation != dialog) return;
        accepted[0] = true;
        dialog.dismiss();
        accept.run();
      });
      return true;
    } catch (RuntimeException unavailable) {
      confirmation = null;
      hold.close();
      return false;
    }
  }

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
    dialog.setOwnerActivity(activity);
    dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    PasswordSurfaces.Hold surface = PasswordSurfaces.open(); // Before an earlier reveal closes, so the surface stays up.
    dismiss();
    dialog.setOnDismissListener(closed -> { value.setText(""); surface.close(); if (current == closed) { current = null; currentSurface = null; REVEAL_TIMER.cancel(); } });
    current = dialog; currentSurface = surface;
    dialog.show();
    REVEAL_TIMER.after(REVEAL_MILLIS, () -> dismissReveal(dialog));
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
    }, () -> dismissReveal(owned));
    return () -> {
      Runnable close = () -> dismissReveal(owned);
      if (Looper.myLooper() == Looper.getMainLooper()) close.run(); else MAIN.post(close);
    };
  }

  static Runnable currentDismissal() {
    return dismissal(current, confirmation);
  }

  private static Runnable dismissal(AlertDialog reveal, AlertDialog confirm) {
    return () -> { dismissConfirmation(confirm); dismissReveal(reveal); };
  }

  static void dismiss(Activity owner) {
    AlertDialog reveal = current, confirm = confirmation;
    Runnable close = dismissal(
      owner != null && reveal != null && reveal.getOwnerActivity() == owner ? reveal : null,
      owner != null && confirm != null && confirm.getOwnerActivity() == owner ? confirm : null);
    if (Looper.myLooper() == Looper.getMainLooper()) close.run(); else MAIN.post(close);
  }

  /** Hide, the timer and every host close end the surface here or in the dismiss listener, whichever is first. */
  static void dismiss() {
    currentDismissal().run();
  }

  private static void dismissConfirmation(AlertDialog owned) {
    if (owned == null || confirmation != owned) return;
    confirmation = null;
    owned.dismiss();
  }

  private static void dismissReveal(AlertDialog owned) {
    if (owned == null || current != owned) return;
    REVEAL_TIMER.cancel();
    PasswordSurfaces.Hold surface = currentSurface; current = null; currentSurface = null;
    if (owned.isShowing()) owned.dismiss();
    if (surface != null) surface.close();
  }

  private static final PasswordClipboard CLIPBOARD = new PasswordClipboard();

  static void copy(Activity activity, String secret) {
    ClipboardManager clipboard = activity.getApplicationContext().getSystemService(ClipboardManager.class);
    if (clipboard == null) throw new IllegalStateException("Clipboard unavailable");
    String label = "eliza-passwords-" + UUID.randomUUID();
    ClipData clip = ClipData.newPlainText(label, secret);
    PersistableBundle extras = new PersistableBundle();
    extras.putBoolean(Build.VERSION.SDK_INT >= 33 ? ClipDescription.EXTRA_IS_SENSITIVE : "android.content.extra.IS_SENSITIVE", true);
    clip.getDescription().setExtras(extras);
    clipboard.setPrimaryClip(clip);
    PasswordClipboard.Lease lease = CLIPBOARD.copied(new PasswordClipboard.Platform() {
      @Override public CharSequence currentLabel() {
        ClipDescription description = clipboard.getPrimaryClipDescription();
        if (description == null) return null;
        return description.getLabel() == null ? "" : description.getLabel();
      }
      @Override public void clear() { clipboard.clearPrimaryClip(); }
    }, label, android.os.SystemClock.elapsedRealtime() + CLIPBOARD_MILLIS);
    MAIN.postDelayed(() -> CLIPBOARD.clearIfDue(lease, android.os.SystemClock.elapsedRealtime()), CLIPBOARD_MILLIS);
  }

  static void retireClipboard() {
    PasswordClipboard.Lease lease = CLIPBOARD.current();
    if (lease == null) return;
    Runnable work = () -> CLIPBOARD.retire(lease, android.os.SystemClock.elapsedRealtime());
    if (Looper.myLooper() == Looper.getMainLooper()) work.run(); else MAIN.post(work);
  }

  static void focused() { CLIPBOARD.clearIfDue(CLIPBOARD.current(), android.os.SystemClock.elapsedRealtime()); }
}
