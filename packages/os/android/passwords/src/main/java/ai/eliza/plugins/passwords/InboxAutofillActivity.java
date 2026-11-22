package ai.eliza.plugins.passwords;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.service.autofill.Dataset;
import android.view.WindowManager;
import android.view.autofill.AutofillManager;

public final class InboxAutofillActivity extends Activity {
  private final CancellationSignal cancelled = new CancellationSignal();
  private InboxAutofill.Selection selection;
  private boolean delivered;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    setResult(RESULT_CANCELED);
    Uri data = getIntent().getData();
    if (state != null || data == null || !InboxAutofill.SCHEME.equals(data.getScheme())) {
      finish();
      return;
    }
    selection = InboxAutofill.select(data.getSchemeSpecificPart());
    if (selection == null) {
      finish();
      return;
    }
    selection.offer.redeem(cancelled, value -> runOnUiThread(() -> {
      if (isFinishing() || isDestroyed() || cancelled.isCanceled())
        return;
      if (value != null && value.isText() && InboxAutofill.deliver(selection)) {
        Dataset result = new Dataset
                             .Builder(ElizaPasswordAutofillService.presentation(
                                 this, getString(R.string.eliza_passwords_inbox_offer)))
                             .setValue(selection.field, value)
                             .build();
        delivered = true;
        setResult(RESULT_OK, new Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, result));
      }
      finish();
    }));
  }
  @Override
  protected void onStop() {
    super.onStop();
    if (!isFinishing())
      finish();
  }
  @Override
  protected void onDestroy() {
    cancelled.cancel();
    if (!delivered && selection != null)
      InboxAutofill.cancel(selection);
    super.onDestroy();
  }
}
