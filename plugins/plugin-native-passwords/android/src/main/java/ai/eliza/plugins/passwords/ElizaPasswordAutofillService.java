package ai.eliza.plugins.passwords;

import ai.eliza.plugins.securestore.nativeonly.PasswordFacets;
import android.app.PendingIntent;
import android.app.assist.AssistStructure;
import android.content.Context;
import android.content.Intent;
import android.content.IntentSender;
import android.net.Uri;
import android.os.CancellationSignal;
import android.service.autofill.AutofillService;
import android.service.autofill.Dataset;
import android.service.autofill.FillCallback;
import android.service.autofill.FillContext;
import android.service.autofill.FillRequest;
import android.service.autofill.FillResponse;
import android.service.autofill.SaveCallback;
import android.service.autofill.SaveInfo;
import android.service.autofill.SaveRequest;
import android.view.autofill.AutofillId;
import android.widget.RemoteViews;
import java.util.List;

/**
 * Android Autofill provider. A fill request never touches the vault: it returns one
 * authentication-gated dataset with no values. Values are produced only by
 * {@link PasswordFillActivity} after the user unlocks and chooses an entry for the exact
 * origin or app. Save requests capture values into memory and hand the user an explicit prompt.
 *
 * <p>Hosts declare this service in their own manifest with
 * {@code android.permission.BIND_AUTOFILL_SERVICE} and
 * {@code @xml/eliza_passwords_autofill_service}.
 */
public class ElizaPasswordAutofillService extends AutofillService {
  @Override public void onFillRequest(FillRequest request, CancellationSignal cancellation, FillCallback callback) {
    FillResponse response = null;
    try { response = fillResponse(this, latest(request.getFillContexts()), cancellation); }
    catch (Exception rejected) { response = null; }
    callback.onSuccess(response);
  }

  @Override public void onSaveRequest(SaveRequest request, SaveCallback callback) {
    try {
      PasswordFormPolicy.Target captured = AutofillStructures.evaluate(this, latest(request.getFillContexts()), true);
      String facet = captured.web() ? captured.webOrigin : PasswordFacets.android(captured.appPackage, PasswordVaultAccess.currentSigner(this, captured.appPackage));
      PasswordVaultAccess access = PasswordVaultAccess.get(this);
      String token = access.requests.offerSave(captured, facet);
      callback.onSuccess(sender(this, PasswordSaveActivity.class, access.config.tokenScheme, token));
    } catch (Exception rejected) {
      // Nothing is retained and no reason is reported to the requesting app.
      callback.onSuccess();
    }
  }

  private static AssistStructure latest(List<FillContext> contexts) {
    return contexts == null || contexts.isEmpty() ? null : contexts.get(contexts.size() - 1).getStructure();
  }

  /** Package seam for instrumentation with synthetic targets. */
  static FillResponse fillResponse(Context context, AssistStructure structure, CancellationSignal cancellation) throws Exception {
    if (cancellation == null || cancellation.isCanceled()) return null;
    PasswordFormPolicy.Target target = AutofillStructures.evaluate(context, structure, false);
    return offer(context, target, cancellation);
  }

  static FillResponse offer(Context context, PasswordFormPolicy.Target target, CancellationSignal cancellation) throws Exception {
    PasswordVaultAccess access = PasswordVaultAccess.get(context);
    String token = access.requests.offerFill(target);
    cancellation.setOnCancelListener(() -> access.requests.cancelFill(token));
    if (cancellation.isCanceled()) { access.requests.cancelFill(token); return null; }
    AutofillId password = (AutofillId) target.passwordId, username = (AutofillId) target.usernameId;
    RemoteViews presentation = presentation(context, context.getString(R.string.eliza_passwords_fill_offer));
    // Values are null: the dataset is authentication-gated and carries no secret.
    Dataset.Builder dataset = new Dataset.Builder(presentation).setValue(password, null);
    if (username != null) dataset.setValue(username, null);
    dataset.setAuthentication(sender(context, PasswordFillActivity.class, access.config.tokenScheme, token));
    SaveInfo.Builder save = new SaveInfo.Builder(SaveInfo.SAVE_DATA_TYPE_PASSWORD | (username == null ? 0 : SaveInfo.SAVE_DATA_TYPE_USERNAME), new AutofillId[]{password});
    if (username != null) save.setOptionalIds(new AutofillId[]{username});
    // Web sign-in usually navigates away instead of submitting a native form.
    save.setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE);
    return new FillResponse.Builder().addDataset(dataset.build()).setSaveInfo(save.build()).build();
  }

  static RemoteViews presentation(Context context, CharSequence text) {
    RemoteViews view = new RemoteViews(context.getPackageName(), android.R.layout.simple_list_item_1);
    view.setTextViewText(android.R.id.text1, text);
    return view;
  }

  static IntentSender sender(Context context, Class<?> activity, String scheme, String token) {
    Intent intent = new Intent(context, activity).setData(Uri.fromParts(scheme, token, null));
    return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_CANCEL_CURRENT).getIntentSender();
  }
}
