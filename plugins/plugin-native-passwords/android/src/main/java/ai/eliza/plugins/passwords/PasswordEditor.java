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
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Creates an entry or edits one at a known revision. Drafts remain in a protected native view and
 * the result contains only an id and revision. The stored password is never loaded here: an edit
 * with an empty password field keeps it, so a metadata edit cannot replace the secret.
 */
final class PasswordEditor {
  interface Result { void saved(String id, long revision); void cancelled(); }
  static final class Busy extends Exception {}
  private static PasswordEditor current;
  private final Activity owner;
  private final PasswordVaultAccess access;
  private final long ticket;
  private final AlertDialog dialog;
  private final EditText label, website, username, password;
  private final TextView others, error;
  private final NativeDeadlineTimer deadline = new NativeDeadlineTimer();
  private final Result result;
  private final String entryId;
  private final PasswordSurfaces.Hold surface;
  private long revision;
  private String storedUsername = "";
  private List<String> storedBindings = Collections.emptyList();
  private AlertDialog sameLogin;
  private boolean finished, stale;

  static void open(Activity activity, PasswordVaultAccess access, long ticket, Result result) throws Exception {
    open(activity, access, ticket, PasswordEditorPolicy.CREATE, result);
  }

  static void open(Activity activity, PasswordVaultAccess access, long ticket, PasswordEditorPolicy.Request request, Result result) throws Exception {
    if (current != null) throw new Busy();
    if (activity.isFinishing() || activity.isDestroyed() || !access.unlocked(ticket)) throw new PasswordVaultAccess.Locked();
    JSONObject entry = null;
    if (request.editing()) {
      entry = access.use(ticket, store -> find(store, request.entryId));
      if (entry == null) throw new IOException("Password no longer exists");
      if (entry.optLong("revision", 0) != request.expectedRevision) throw new PasswordVaultStore.RevisionConflict();
    }
    PasswordEditor editor = new PasswordEditor(activity, access, ticket, request.entryId, result);
    SecretSurfaces.dismiss();
    current = editor;
    try {
      if (entry != null) editor.show(entry);
      editor.dialog.show();
      editor.deadline.watch(() -> access.unlocked(ticket) ? access.remainingMillis() : 0, editor::cancel);
    } catch (Exception failure) { editor.clear(); throw failure; }
  }

  /** Metadata only: {@link PasswordVaultStore#entries} never includes a password. */
  private static JSONObject find(PasswordVaultStore store, String id) throws Exception {
    JSONArray entries = store.entries();
    for (int i = 0; i < entries.length(); i++) if (entries.getJSONObject(i).getString("id").equals(id)) return entries.getJSONObject(i);
    return null;
  }

  private PasswordEditor(Activity activity, PasswordVaultAccess access, long ticket, String entryId, Result result) {
    this.owner = activity;
    this.access = access;
    this.ticket = ticket;
    this.entryId = entryId;
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
    others = new TextView(activity); others.setVisibility(View.GONE); fields.addView(others);
    username = field(activity, fields, R.string.eliza_passwords_editor_username, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD, PasswordVaultStore.MAX_USERNAME);
    password = field(activity, fields, R.string.eliza_passwords_editor_password, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, PasswordVaultStore.MAX_PASSWORD);
    if (entryId != null) { TextView keep = new TextView(activity); keep.setText(R.string.eliza_passwords_editor_keep_password); fields.addView(keep); }
    Button generate = new Button(activity); generate.setText(R.string.eliza_passwords_editor_generate);
    generate.setFilterTouchesWhenObscured(true);
    generate.setOnClickListener(view -> {
      if (!access.unlocked(ticket)) { cancel(); return; }
      password.setText(PasswordGenerator.generate(new PasswordGenerator.Options(24, true, true, true, true), new SecureRandom()));
    }); fields.addView(generate);
    error = new TextView(activity); error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); fields.addView(error);
    ScrollView scroll = new ScrollView(activity); scroll.setSaveEnabled(false); scroll.addView(fields);
    dialog = new AlertDialog.Builder(activity).setTitle(entryId == null ? R.string.eliza_passwords_editor_title : R.string.eliza_passwords_editor_edit_title).setView(scroll)
      .setNegativeButton(R.string.eliza_passwords_cancel, (shown, which) -> cancel())
      .setPositiveButton(R.string.eliza_passwords_save, null).create();
    dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    dialog.setOnCancelListener(shown -> cancel());
    dialog.setOnDismissListener(shown -> cancel());
    dialog.setOnShowListener(shown -> {
      protectAction(dialog.getButton(AlertDialog.BUTTON_NEGATIVE));
      Button save = dialog.getButton(AlertDialog.BUTTON_POSITIVE); protectAction(save);
      save.setOnClickListener(view -> submit());
    });
    surface = PasswordSurfaces.open(); // Its questions and Reload belong to this same surface.
  }

  /** Loads one record's metadata as the base of this edit. Discards any typed password. */
  private void show(JSONObject entry) throws Exception {
    revision = entry.optLong("revision", 0);
    storedUsername = entry.getString("username");
    storedBindings = PasswordVaultStore.bindings(entry);
    label.setText(entry.getString("label"));
    website.setText(PasswordEditorPolicy.firstWeb(storedBindings));
    username.setText(storedUsername);
    password.setText("");
    List<String> kept = new ArrayList<>();
    for (String facet : PasswordEditorPolicy.editedBindings(storedBindings, null)) kept.add(PasswordSheet.bindingLabel(owner, facet));
    others.setText(kept.isEmpty() ? "" : owner.getString(R.string.eliza_passwords_editor_also_used, String.join(", ", kept)));
    others.setVisibility(kept.isEmpty() ? View.GONE : View.VISIBLE);
  }

  private void submit() {
    if (finished) return;
    if (stale) { reload(); return; }
    try {
      // Exact-origin validation happens before reading a draft secret. No URL stripping.
      String typed = website.getText().toString();
      String origin = entryId != null && typed.trim().isEmpty() ? null : PasswordFacets.web(typed);
      List<String> facets = entryId == null ? Collections.singletonList(origin) : PasswordEditorPolicy.editedBindings(storedBindings, origin);
      String draft = password.getText().toString();
      if (entryId == null && draft.isEmpty()) { error.setText(R.string.eliza_passwords_editor_invalid); return; }
      String name = username.getText().toString();
      boolean unchanged = entryId != null && name.equals(storedUsername) && storedBindings.containsAll(facets);
      JSONObject same = unchanged ? null : access.use(ticket, store -> sameLogin(store, name, facets));
      if (same != null) { askSameLogin(same, facets); return; }
      commit(entryId, revision, label.getText().toString(), facets);
    } catch (PasswordVaultAccess.Locked locked) { cancel(); }
    catch (Exception failure) { error.setText(R.string.eliza_passwords_editor_invalid); }
  }

  /** Another entry with this username on any of these bindings. Never merged silently. */
  private JSONObject sameLogin(PasswordVaultStore store, String name, List<String> facets) throws Exception {
    JSONArray entries = store.entries();
    for (int i = 0; i < entries.length(); i++) {
      JSONObject entry = entries.getJSONObject(i);
      if (entry.getString("id").equals(entryId) || !entry.getString("username").equals(name)) continue;
      if (!Collections.disjoint(PasswordVaultStore.bindings(entry), facets)) return entry;
    }
    return null;
  }

  /** Update existing replaces only that entry's password, at the revision shown here. An edit can
   * keep separate or go back; merging two entries is not offered. */
  private void askSameLogin(JSONObject same, List<String> facets) throws Exception {
    AlertDialog.Builder ask = new AlertDialog.Builder(owner).setTitle(R.string.eliza_passwords_editor_same_title)
      .setMessage(owner.getString(R.string.eliza_passwords_editor_same_message, same.getString("label")))
      .setNegativeButton(R.string.eliza_passwords_editor_back, null)
      .setNeutralButton(R.string.eliza_passwords_editor_keep_separate, (shown, which) -> commit(entryId, revision, label.getText().toString(), facets));
    if (entryId == null) {
      String id = same.getString("id"), name = same.getString("label");
      long sameRevision = same.optLong("revision", 0);
      List<String> sameBindings = PasswordVaultStore.bindings(same);
      ask.setPositiveButton(R.string.eliza_passwords_editor_update_existing, (shown, which) -> commit(id, sameRevision, name, sameBindings));
    }
    sameLogin = ask.create();
    sameLogin.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    AlertDialog shownDialog = sameLogin;
    shownDialog.setOnShowListener(shown -> {
      for (int which : new int[]{AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL}) {
        Button action = shownDialog.getButton(which);
        if (action != null) protectAction(action);
      }
    });
    sameLogin.show();
  }

  /** One compare-and-swap. An empty password field keeps the stored password on an update. */
  private void commit(String id, long base, String name, List<String> facets) {
    if (finished) return;
    String draft = password.getText().toString();
    try {
      JSONObject saved = access.use(ticket, store -> store.commitEntry(id, base, name, username.getText().toString(), facets, id != null && draft.isEmpty() ? null : draft));
      finish(saved.getString("id"), saved.getLong("revision"));
    } catch (PasswordVaultStore.RevisionConflict conflict) {
      if (entryId == null) { error.setText(R.string.eliza_passwords_editor_changed_retry); return; }
      stale = true;
      error.setText(R.string.eliza_passwords_editor_changed);
      dialog.getButton(AlertDialog.BUTTON_POSITIVE).setText(R.string.eliza_passwords_editor_reload);
    } catch (PasswordVaultAccess.Locked locked) { cancel(); }
    catch (Exception failure) { error.setText(R.string.eliza_passwords_editor_invalid); }
  }

  /** Reload is the only way past a conflict. It shows the latest record and discards the draft. */
  private void reload() {
    Button save = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
    try {
      JSONObject entry = access.use(ticket, store -> find(store, entryId));
      if (entry == null) { error.setText(R.string.eliza_passwords_editor_gone); save.setVisibility(View.GONE); return; }
      show(entry);
      stale = false;
      error.setText("");
      save.setText(R.string.eliza_passwords_save);
    } catch (PasswordVaultAccess.Locked locked) { cancel(); }
    catch (Exception failure) { error.setText(R.string.eliza_passwords_editor_invalid); }
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
    if (sameLogin != null && sameLogin.isShowing()) sameLogin.dismiss();
    if (dialog.isShowing()) dialog.dismiss();
    surface.close();
    return true;
  }

  private void finish(String id, long saved) { if (clear()) result.saved(id, saved); }
  private void cancel() { if (clear()) result.cancelled(); }

  static void dismiss() { PasswordEditor editor = current; if (editor != null) editor.cancel(); }
  static void dismiss(Activity owner) { PasswordEditor editor = current; if (editor != null && editor.owner == owner) editor.cancel(); }
}
