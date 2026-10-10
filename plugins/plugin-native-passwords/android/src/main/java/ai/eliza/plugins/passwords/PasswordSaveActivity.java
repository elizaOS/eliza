package ai.eliza.plugins.passwords;

import ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore;
import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Explicit "save password?" prompt for an Autofill save request. Captured values live only in
 * memory, are consumed once, and are written only after the user chooses Save and unlocks.
 * App bindings record the app's current signing certificate at capture time.
 */
public class PasswordSaveActivity extends Activity {
  private PasswordRequests.SaveCapture captured;
  private PasswordSheet sheet;
  private PasswordVaultAccess access;
  private long ticket;
  private boolean prompting, finished;

  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    sheet = new PasswordSheet(this);
    try { access = PasswordVaultAccess.get(this); } catch (Exception unavailable) { close(); return; }
    Uri data = getIntent() == null ? null : getIntent().getData();
    if (state != null || data == null || !access.config.tokenScheme.equals(data.getScheme())) { close(); return; }
    captured = access.requests.takeSave(data.getSchemeSpecificPart());
    if (captured == null) { close(); return; }
    sheet.title.setText(R.string.eliza_passwords_save_title);
    sheet.subtitle.setText(PasswordSheet.subject(this, captured.target) + "\n" + (captured.target.username.isEmpty() ? getString(R.string.eliza_passwords_no_username) : captured.target.username));
    sheet.list.addView(sheet.button(this, getString(R.string.eliza_passwords_save), view -> save()));
    sheet.list.addView(sheet.button(this, getString(R.string.eliza_passwords_not_now), view -> close()));
  }

  private void save() {
    if (finished || captured == null) return;
    for (int i = 0; i < sheet.list.getChildCount(); i++) sheet.list.getChildAt(i).setEnabled(false);
    ticket = access.ticket();
    if (ticket != 0) { write(); return; }
    prompting = true;
    PasswordUnlock.prompt(this, new PasswordUnlock.Result() {
      @Override public void unlocked(long granted) { ticket = granted; prompting = false; if (!finished) write(); }
      @Override public void failed(String code) {
        prompting = false;
        if (finished) return;
        if ("no-screen-lock".equals(code)) sheet.status.setText(R.string.eliza_passwords_no_screen_lock);
        for (int i = 0; i < sheet.list.getChildCount(); i++) sheet.list.getChildAt(i).setEnabled(true);
      }
    });
  }

  private void write() {
    PasswordFormPolicy.Target value = captured.target;
    String facet = captured.facet;
    long owner = ticket;
    PasswordSheet.IO.execute(() -> {
      boolean saved;
      try {
        String label = PasswordSheet.subject(this, value);
        saved = access.use(owner, store -> {
          // Same binding and username: update that entry's password instead of duplicating it.
          JSONArray entries = store.entries();
          for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.getJSONObject(i);
            List<String> bindings = PasswordVaultStore.bindings(entry);
            if (bindings.contains(facet) && entry.getString("username").equals(value.username)) {
              store.saveEntry(entry.getString("id"), entry.getString("label"), value.username, bindings, value.password);
              return true;
            }
          }
          List<String> bindings = new ArrayList<>(); bindings.add(facet);
          store.saveEntry(null, label, value.username, bindings, value.password);
          return true;
        });
      } catch (Exception failure) { saved = false; }
      boolean result = saved;
      runOnUiThread(() -> {
        if (finished || isDestroyed()) return;
        Toast.makeText(this, result ? R.string.eliza_passwords_saved : R.string.eliza_passwords_save_failed, Toast.LENGTH_SHORT).show();
        close();
      });
    });
  }

  private void close() {
    if (finished) return;
    finished = true; captured = null;
    if (access != null) access.lock(ticket);
    finish();
  }

  @Override protected void onStop() {
    super.onStop();
    if (!prompting && !isChangingConfigurations()) close();
  }

  @Override protected void onDestroy() {
    close();
    super.onDestroy();
  }
}
