package ai.eliza.plugins.passwords;

import ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.service.autofill.Dataset;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillManager;
import android.view.autofill.AutofillValue;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Authentication target of the fill dataset. Requires a fresh unlock in this picker and an
 * explicit choice of one entry bound to the admitted origin or app. Returns exactly one Dataset to the
 * framework, which fills only the request's own field ids. Nothing else leaves this Activity.
 */
public class PasswordFillActivity extends Activity {
  private PasswordFormPolicy.Target target;
  private PasswordSheet sheet;
  private PasswordVaultAccess access;
  private String requestToken;
  private long ticket;
  private boolean prompting, finished;

  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    setResult(RESULT_CANCELED);
    sheet = new PasswordSheet(this);
    try { access = PasswordVaultAccess.get(this); } catch (Exception unavailable) { cancel(); return; }
    Uri data = getIntent() == null ? null : getIntent().getData();
    // Saved state never restores a capability: recreated Activities start over.
    if (state != null || data == null || !access.config.tokenScheme.equals(data.getScheme())) { cancel(); return; }
    requestToken = data.getSchemeSpecificPart();
    target = access.requests.takeFill(requestToken);
    if (target == null) { cancel(); return; }
    sheet.title.setText(R.string.eliza_passwords_fill_title);
    sheet.subtitle.setText(getString(R.string.eliza_passwords_fill_for, PasswordSheet.subject(this, target)));
    sheet.root.addView(sheet.button(this, getString(R.string.eliza_passwords_cancel), view -> cancel()));
    // Every fill authenticates in this picker. An earlier unlock (Settings, another fill) is
    // never reused here: begin() in PasswordUnlock drops any existing grant first.
    unlock();
  }

  private void unlock() {
    prompting = true;
    PasswordUnlock.prompt(this, new PasswordUnlock.Result() {
      @Override public void unlocked(long granted) { ticket = granted; prompting = false; if (!finished) load(); }
      @Override public void failed(String code) {
        prompting = false;
        if (finished) return;
        if ("no-screen-lock".equals(code)) sheet.status.setText(R.string.eliza_passwords_no_screen_lock); else cancel();
      }
    });
  }

  private boolean current() { return !finished && target != null && access.requests.currentFill(requestToken) && access.unlocked(ticket); }

  private void load() {
    long owner = ticket;
    PasswordFormPolicy.Target request = target;
    PasswordSheet.IO.execute(() -> {
      JSONArray choices = new JSONArray();
      boolean failed = false;
      try {
        JSONArray entries = access.use(owner, PasswordVaultStore::entries);
        for (int i = 0; i < entries.length(); i++) {
          JSONObject entry = entries.getJSONObject(i);
          if (PasswordMatching.matches(PasswordVaultStore.bindings(entry), request, (pkg, cert) -> PasswordsConfig.signedBy(this, pkg, cert))) choices.put(entry);
        }
      } catch (Exception unavailable) { failed = true; }
      boolean unavailable = failed;
      runOnUiThread(() -> show(choices, unavailable));
    });
  }

  private void show(JSONArray choices, boolean unavailable) {
    if (!current()) { if (!finished && !prompting) cancel(); return; }
    sheet.list.removeAllViews();
    if (unavailable) { sheet.status.setText(R.string.eliza_passwords_unavailable); return; }
    if (choices.length() == 0) { sheet.status.setText(getString(R.string.eliza_passwords_fill_none, PasswordSheet.subject(this, target))); return; }
    for (int i = 0; i < choices.length(); i++) {
      JSONObject entry = choices.optJSONObject(i);
      String id = entry.optString("id"), username = entry.optString("username");
      String label = entry.optString("label") + "\n" + (username.isEmpty() ? getString(R.string.eliza_passwords_no_username) : username);
      sheet.list.addView(sheet.button(this, label, view -> choose(id)));
    }
  }

  private void choose(String id) {
    if (!current()) { cancel(); return; }
    long owner = ticket;
    PasswordFormPolicy.Target request = target;
    for (int i = 0; i < sheet.list.getChildCount(); i++) sheet.list.getChildAt(i).setEnabled(false);
    PasswordSheet.IO.execute(() -> {
      Dataset dataset = null;
      try {
        JSONObject record = access.use(owner, store -> store.get(id));
        // Re-check the binding against the record actually read, not the earlier listing.
        if (PasswordMatching.matches(PasswordVaultStore.bindings(record), request, (pkg, cert) -> PasswordsConfig.signedBy(this, pkg, cert))) {
          Dataset.Builder builder = new Dataset.Builder(ElizaPasswordAutofillService.presentation(this, record.optString("label", "")))
            .setValue((AutofillId) request.passwordId, AutofillValue.forText(record.getString("password")));
          if (request.usernameId != null) builder.setValue((AutofillId) request.usernameId, AutofillValue.forText(record.getString("username")));
          dataset = builder.build();
        }
      } catch (Exception unavailable) { dataset = null; }
      Dataset result = dataset;
      runOnUiThread(() -> {
        if (result == null || !current() || !access.requests.claimFill(requestToken)) { cancel(); return; }
        finished = true;
        setResult(RESULT_OK, new Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, result));
        finish();
      });
    });
  }

  private void cancel() {
    if (finished) return;
    finished = true; target = null;
    if (access != null) { access.requests.cancelFill(requestToken); access.lock(ticket); }
    setResult(RESULT_CANCELED); finish();
  }

  @Override protected void onStop() {
    super.onStop();
    // The device-credential screen stops this Activity while it is in front; anything else
    // abandons the request rather than leaving a picker for a stale form.
    if (!prompting && !isChangingConfigurations()) cancel();
  }

  @Override protected void onDestroy() {
    cancel();
    if (access != null) { access.requests.cancelFill(requestToken); access.lock(ticket); }
    target = null;
    super.onDestroy();
  }
}
