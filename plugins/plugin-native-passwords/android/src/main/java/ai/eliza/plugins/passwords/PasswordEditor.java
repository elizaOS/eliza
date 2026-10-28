package ai.eliza.plugins.passwords;

import ai.eliza.plugins.securestore.nativeonly.NativeDeadlineTimer;
import ai.eliza.plugins.securestore.nativeonly.PasswordFacets;
import ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore;
import android.text.InputFilter;
import android.app.Activity;
import android.app.AlertDialog;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.security.SecureRandom;
import java.util.Collections;

/** Creation only. Drafts remain in a protected native view; the result contains only an id. */
final class PasswordEditor {
  interface Result { void saved(String id); void cancelled(); }
  static final class Busy extends Exception {}
  private static PasswordEditor current;
  private final Activity owner;
  private final AlertDialog dialog;
  private final EditText label, website, username, password;
  private final NativeDeadlineTimer deadline = new NativeDeadlineTimer();
  private final Result result;
  private boolean finished;

  static void open(Activity activity, PasswordVaultAccess access, long ticket, Result result) throws Exception {
    if (current != null) throw new Busy();
    if (activity.isFinishing() || activity.isDestroyed() || !access.unlocked(ticket)) throw new PasswordVaultAccess.Locked();
    SecretSurfaces.dismiss();
    PasswordEditor editor = new PasswordEditor(activity, access, ticket, result);
    current = editor;
    try { editor.dialog.show(); editor.deadline.watch(() -> access.unlocked(ticket) ? access.remainingMillis() : 0, () -> editor.finish(null)); }
    catch (RuntimeException failure) { editor.clear(); throw failure; }
  }

  private PasswordEditor(Activity activity, PasswordVaultAccess access, long ticket, Result result) {
    this.owner = activity;
    this.result = result;
    LinearLayout fields = new LinearLayout(activity) {
      @Override public boolean dispatchTouchEvent(android.view.MotionEvent event) {
        if ((event.getFlags() & (android.view.MotionEvent.FLAG_WINDOW_IS_OBSCURED | android.view.MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED)) != 0) return false;
        return super.dispatchTouchEvent(event);
      }
    }; fields.setOrientation(LinearLayout.VERTICAL);
    fields.setSaveEnabled(false); fields.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
    int pad = PasswordSheet.dp(activity, 20); fields.setPadding(pad, pad, pad, pad);
    label = field(activity, fields, R.string.eliza_passwords_editor_label, InputType.TYPE_CLASS_TEXT, PasswordVaultStore.MAX_LABEL);
    website = field(activity, fields, R.string.eliza_passwords_editor_website, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI, 512);
    username = field(activity, fields, R.string.eliza_passwords_editor_username, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD, PasswordVaultStore.MAX_USERNAME);
    password = field(activity, fields, R.string.eliza_passwords_editor_password, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, PasswordVaultStore.MAX_PASSWORD);
    Button generate = new Button(activity); generate.setText(R.string.eliza_passwords_editor_generate);
    generate.setFilterTouchesWhenObscured(true);
    generate.setOnClickListener(view -> {
      if (!access.unlocked(ticket)) { finish(null); return; }
      password.setText(PasswordGenerator.generate(new PasswordGenerator.Options(24, true, true, true, true), new SecureRandom()));
    }); fields.addView(generate);
    TextView error = new TextView(activity); error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); fields.addView(error);
    ScrollView scroll = new ScrollView(activity); scroll.setSaveEnabled(false); scroll.addView(fields);
    dialog = new AlertDialog.Builder(activity).setTitle(R.string.eliza_passwords_editor_title).setView(scroll)
      .setNegativeButton(R.string.eliza_passwords_cancel, (shown, which) -> finish(null))
      .setPositiveButton(R.string.eliza_passwords_save, null).create();
    dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    dialog.setOnCancelListener(shown -> finish(null));
    dialog.setOnDismissListener(shown -> finish(null));
    dialog.setOnShowListener(shown -> {
      protectAction(dialog.getButton(AlertDialog.BUTTON_NEGATIVE));
      Button save = dialog.getButton(AlertDialog.BUTTON_POSITIVE); protectAction(save);
      save.setOnClickListener(view -> {
        if (finished) return;
        try {
          // Exact-origin validation happens before reading a draft secret. No URL stripping.
          String origin = PasswordFacets.web(website.getText().toString());
          String id = access.use(ticket, store -> store.saveEntry(null, label.getText().toString(), username.getText().toString(),
            Collections.singletonList(origin), password.getText().toString()));
          finish(id);
        } catch (PasswordVaultAccess.Locked locked) { finish(null); }
        catch (Exception failure) { error.setText(R.string.eliza_passwords_editor_invalid); }
      });
    });
  }

  private static void protectAction(Button action) {
    action.setFilterTouchesWhenObscured(true);
    action.setOnTouchListener((view, event) -> (event.getFlags() &
      (android.view.MotionEvent.FLAG_WINDOW_IS_OBSCURED | android.view.MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED)) != 0);
  }

  private static EditText field(Activity activity, LinearLayout parent, int title, int inputType, int max) {
    TextView caption = new TextView(activity); caption.setText(title); parent.addView(caption);
    EditText value = new EditText(activity) {
      @Override public boolean onTextContextMenuItem(int action) {
        if (title == R.string.eliza_passwords_editor_password && action != android.R.id.paste && action != android.R.id.pasteAsPlainText && action != android.R.id.selectAll) return false;
        return super.onTextContextMenuItem(action);
      }
    }; value.setId(View.generateViewId()); caption.setLabelFor(value.getId());
    value.setContentDescription(activity.getString(title)); value.setSingleLine(true); value.setInputType(inputType);
    if (title == R.string.eliza_passwords_editor_password) value.setTransformationMethod(android.text.method.PasswordTransformationMethod.getInstance());
    int[] editRevision = {0};
    value.setFilters(new InputFilter[]{(source, start, end, dest, dstart, dend) -> {
      int revision = ++editRevision[0];
      if ((long) dest.length() - (dend - dstart) + end - start <= max) return null;
      value.post(() -> { if (revision == editRevision[0]) value.setError(activity.getString(R.string.eliza_passwords_editor_too_long, max)); });
      return dest.subSequence(dstart, dend); // Reject the entire edit; never truncate a secret.
    }});
    value.setMinHeight(PasswordSheet.dp(activity, 48));
    value.setSaveEnabled(false); value.setSaveFromParentEnabled(false); value.setFilterTouchesWhenObscured(true);
    value.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); value.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
    parent.addView(value); return value;
  }

  private boolean clear() {
    if (finished) return false;
    finished = true; deadline.cancel();
    if (current == this) current = null;
    label.setText(""); website.setText(""); username.setText(""); password.setText("");
    if (dialog.isShowing()) dialog.dismiss();
    return true;
  }

  private void finish(String id) {
    if (!clear()) return;
    if (id == null) result.cancelled(); else result.saved(id);
  }

  static void dismiss() { PasswordEditor editor = current; if (editor != null) editor.finish(null); }
  static void dismiss(Activity owner) { PasswordEditor editor = current; if (editor != null && editor.owner == owner) editor.finish(null); }
}
