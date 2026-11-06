package ai.eliza.plugins.securestore.nativeonly;

import android.content.Intent;
import android.os.Looper;
import android.service.autofill.Dataset;
import android.service.autofill.FillResponse;
import android.view.autofill.AutofillManager;
import android.view.autofill.AutofillValue;
import android.widget.RemoteViews;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native-only exact-origin selection and one-shot Android Autofill completion. */
public final class PasswordAutofillCompletion {
  private PasswordAutofillCompletion() {}

  private static void require(PasswordAutofillSessions.Session session, BooleanSupplier permitted) {
    if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Autofill completion requires the main thread");
    if (session == null || permitted == null || !session.valid() || !permitted.getAsBoolean() || !session.valid())
      throw new SecurityException("Autofill authorization unavailable");
  }

  /** Returns metadata only. Host authorization must check current authentication and browser trust. */
  public static JSONArray choices(PasswordAutofillSessions.Session session, PasswordVaultStore vault, BooleanSupplier permitted) throws Exception {
    require(session, permitted);
    JSONArray records = vault.list(), choices = new JSONArray();
    for (int i = 0; i < records.length(); i++) {
      JSONObject item = records.getJSONObject(i);
      if (session.request.origin.equals(item.getString("origin")))
        choices.put(new JSONObject().put("id", item.getString("id")).put("username", item.getString("username")));
    }
    require(session, permitted);
    return choices;
  }

  /** Consumes before publication; a throwing publisher cannot make the capability reusable. */
  public static void complete(PasswordAutofillSessions.Session session, PasswordVaultStore vault, BooleanSupplier permitted,
      String id, RemoteViews presentation, Consumer<Intent> publish) throws Exception {
    require(session, permitted);
    if (presentation == null || publish == null) throw new IllegalArgumentException("Missing Autofill presentation or publisher");
    JSONObject item = vault.get(id);
    if (!session.request.origin.equals(item.getString("origin"))) throw new SecurityException("Autofill origin changed");
    Dataset dataset = new Dataset.Builder(presentation)
      .setValue(session.request.username, AutofillValue.forText(item.getString("username")))
      .setValue(session.request.password, AutofillValue.forText(item.getString("password"))).build();
    Intent result = new Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, new FillResponse.Builder().addDataset(dataset).build());
    require(session, permitted);
    if (!PasswordAutofillSessions.claim(session)) throw new SecurityException("Autofill capability already consumed");
    publish.accept(result);
  }
}
