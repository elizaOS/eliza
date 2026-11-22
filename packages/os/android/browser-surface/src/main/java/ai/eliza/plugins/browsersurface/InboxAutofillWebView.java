package ai.eliza.plugins.browsersurface;

import android.content.ComponentName;
import android.content.Context;
import android.os.Bundle;
import android.util.SparseArray;
import android.view.View;
import android.view.ViewStructure;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillManager;
import android.view.autofill.AutofillValue;
import android.webkit.WebView;
import androidx.annotation.RequiresApi;
import java.lang.ref.WeakReference;
import java.util.UUID;
import java.util.function.IntFunction;

@RequiresApi(28)
public final class InboxAutofillWebView extends WebView {
  public interface DeliveryGate {
    boolean claim(String fieldLease, String origin, String challenge);
  }
  private static volatile DeliveryGate deliveryGate;
  private static WeakReference<InboxAutofillWebView> selected = new WeakReference<>(null);
  private static final String PROVIDER = "ai.eliza.plugins.passwords.ElizaPasswordAutofillService";
  static final String LEASE = "ai.eliza.inbox.fieldLease";
  static final String CHALLENGE = "ai.eliza.inbox.challenge";
  private static final class Field {
    final BrowserLoginFields.Host host;
    final String document, challenge, lease = UUID.randomUUID().toString();
    final long navigation;
    final SparseArray<AutofillId> ids = new SparseArray<>();
    int offered = View.NO_ID;

    Field(BrowserLoginFields.Host host, String document, String challenge, long navigation) {
      this.host = host;
      this.document = document;
      this.challenge = challenge;
      this.navigation = navigation;
    }
  }
  private Field field;

  public InboxAutofillWebView(Context context) {
    super(context);
    setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
  }
  public static void setDeliveryGate(DeliveryGate gate) {
    deliveryGate = gate;
  }

  public static boolean isFieldCurrent(String lease, String origin, String challenge, boolean visible) {
    InboxAutofillWebView view = selected.get();
    Field field = view == null ? null : view.field;
    if (field == null || field.offered == View.NO_ID || !field.lease.equals(lease)
        || !field.challenge.equals(challenge) || !InboxFieldStructure.ORIGIN.equals(origin))
      return false;
    if (visible)
      return view.eligible(field);
    BrowserFieldOrigin.TabSnapshot snapshot = field.host.snapshot();
    return snapshot != null && snapshot.supported && snapshot.navigation == field.navigation
        && snapshot.state != null && snapshot.state.selected && !snapshot.state.closed
        && !snapshot.state.overlay && snapshot.state.committed && !snapshot.state.loading
        && "".equals(snapshot.state.loadError)
        && InboxFieldStructure.ORIGIN.equals(BrowserFieldOrigin.exactHttps(snapshot.state.documentUrl))
        && snapshot.state.documentUrl.equals(snapshot.state.engineUrl);
  }
  void focused(BrowserLoginFields.Host host, String document, String challenge) {
    forget();
    field = new Field(host, document, challenge, host.snapshot().navigation);
    if (!eligible(field)) {
      forget();
      return;
    }
    selected = new WeakReference<>(this);
    setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_YES);
    getContext().getSystemService(AutofillManager.class).requestAutofill(this);
  }
  void left(String document) {
    if (field != null && field.document.equals(document))
      forget();
  }
  void forget() {
    if (selected.get() == this)
      selected.clear();
    field = null;
    setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
  }
  private boolean eligible(Field current) {
    if (current == null || field != current || deliveryGate == null || !hasWindowFocus())
      return false;
    AutofillManager manager = getContext().getSystemService(AutofillManager.class);
    ComponentName provider = manager == null ? null : manager.getAutofillServiceComponentName();
    if (provider == null || !getContext().getPackageName().equals(provider.getPackageName())
        || !PROVIDER.equals(provider.getClassName()))
      return false;
    BrowserFieldOrigin.TabSnapshot tab = current.host.snapshot();
    return tab != null && tab.supported && current.navigation == tab.navigation
        && BrowserAutofillEligibility.eligible(tab.state)
        && InboxFieldStructure.ORIGIN.equals(BrowserFieldOrigin.exactHttps(tab.state.documentUrl));
  }
  private InboxFieldStructure currentField(Field current, IntFunction<AutofillId> resolve) {
    InboxFieldStructure capture = new InboxFieldStructure(getAutofillId(), resolve);
    super.onProvideAutofillVirtualStructure(capture, 0);
    return capture.selected(current.challenge);
  }
  @Override
  public void onProvideAutofillVirtualStructure(ViewStructure structure, int flags) {
    Field current = field;
    structure.setChildCount(0);
    if (!eligible(current))
      return;
    try {
      structure.setChildCount(1);
      ViewStructure target = structure.newChild(0);
      current.ids.clear();
      InboxFieldStructure found = currentField(current, id -> {
        target.setAutofillId(getAutofillId(), id);
        AutofillId value = target.getAutofillId();
        current.ids.put(id, value);
        return value;
      });
      if (found == null) {
        current.offered = View.NO_ID;
        structure.setChildCount(0);
        return;
      }
      target.setAutofillId(getAutofillId(), found.virtualId);
      target.setClassName("android.widget.EditText");
      target.setEnabled(true);
      target.setFocusable(true);
      target.setFocused(true);
      target.setAutofillType(View.AUTOFILL_TYPE_TEXT);
      target.setAutofillHints(new String[] {InboxFieldStructure.HINT});
      target.setDataIsSensitive(true);
      target.setWebDomain(InboxFieldStructure.ORIGIN);
      target.setDimens(found.left, found.top, 0, 0, found.width, found.height);
      Bundle extras = target.getExtras();
      extras.putString(BrowserAutofillExtras.ELIZA_PASSWORDS.fieldOrigin, InboxFieldStructure.ORIGIN);
      extras.putString(LEASE, current.lease);
      extras.putString(CHALLENGE, current.challenge);
      current.offered = found.virtualId;
    } catch (RuntimeException unsupported) {
      current.offered = View.NO_ID;
      structure.setChildCount(0);
    }
  }
  @Override
  public void autofill(SparseArray<AutofillValue> values) {
    Field current = field;
    if (!eligible(current) || current.offered == View.NO_ID || values == null || values.size() != 1
        || values.keyAt(0) != current.offered || values.valueAt(0) == null || !values.valueAt(0).isText())
      return;
    try {
      InboxFieldStructure found = currentField(current, id -> {
        AutofillId known = current.ids.get(id);
        if (known == null)
          throw new IllegalArgumentException("Autofill form changed");
        return known;
      });
      DeliveryGate gate = deliveryGate;
      if (found != null && found.virtualId == current.offered && gate != null && eligible(current)
          && gate.claim(current.lease, InboxFieldStructure.ORIGIN, current.challenge))
        super.autofill(values);
    } catch (RuntimeException unsupported) {
      return;
    } finally {
      forget();
    }
  }
}
