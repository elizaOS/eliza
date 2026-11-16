package ai.eliza.auth.cloud;

import android.accounts.Account;
import android.app.Activity;
import android.os.CancellationSignal;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Android's Google account picker. ID tokens remain native and are never logged or bridged. */
public final class NativeGoogleCredential {
 private NativeGoogleCredential() {}
 public interface Callback {
  void token(String idToken, String account);
  void failure(String code);
 }
 public interface Authorization {
  void code(String serverAuthCode);
  void failure(String reason);
 }
 public static void request(Activity activity, String serverClientId, String nonce,
                     CancellationSignal cancellation, Callback callback) {
  if (activity == null || activity.isFinishing() || activity.isDestroyed()
      || serverClientId == null || !serverClientId.matches("[0-9]+-[A-Za-z0-9_-]+\\.apps\\.googleusercontent\\.com")
      || nonce == null || !nonce.matches("[A-Za-z0-9_-]{32,256}")) {
   callback.failure("unavailable");
   return;
  }
  try {
   GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(serverClientId)
       .setNonce(nonce).build();
   GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
   CredentialManager.create(activity).getCredentialAsync(activity, request, cancellation,
       ContextCompat.getMainExecutor(activity), new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
    @Override public void onResult(GetCredentialResponse response) {
     if (cancellation.isCanceled()) { callback.failure("cancelled"); return; }
     final String token, account;
     try {
      Credential credential = response.getCredential();
      if (!(credential instanceof CustomCredential)
          || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
       callback.failure("provider-refused");
       return;
      }
      GoogleIdTokenCredential google = GoogleIdTokenCredential.createFrom(credential.getData());
      token = google.getIdToken(); account = google.getId();
      if (token == null || token.isEmpty() || token.length() > 32768) {
       callback.failure("provider-refused");
       return;
      }
     } catch (Exception invalidCredential) { callback.failure("provider-refused"); return; }
     callback.token(token, account);
    }
    @Override public void onError(GetCredentialException error) {
     callback.failure(error instanceof GetCredentialCancellationException ? "cancelled"
         : error instanceof NoCredentialException ? "google-account-unavailable" : "unavailable");
    }
   });
  } catch (Exception unavailable) { callback.failure("unavailable"); }
 }
 public static void authorize(Activity activity, String serverClientId, String account, List<String> scopes,
                       CancellationSignal cancellation, Authorization callback) {
  if (!(activity instanceof ComponentActivity) || activity.isFinishing() || activity.isDestroyed()
      || serverClientId == null || !serverClientId.matches("[0-9]+-[A-Za-z0-9_-]+\\.apps\\.googleusercontent\\.com")
      || account == null || account.isEmpty() || scopes.isEmpty()) {
   callback.failure("google_unavailable");
   return;
  }
  try {
   List<Scope> requested = new ArrayList<>();
   for (String scope : scopes) requested.add(new Scope(scope));
   AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(requested)
       .setAccount(new Account(account, "com.google")).requestOfflineAccess(serverClientId, true).build();
   Identity.getAuthorizationClient(activity).authorize(request)
       .addOnSuccessListener(activity, result -> {
        if (cancellation.isCanceled()) { callback.failure("google_declined"); return; }
        if (!result.hasResolution()) { authorized(result, callback); return; }
        ComponentActivity host = (ComponentActivity) activity;
        @SuppressWarnings("unchecked") final ActivityResultLauncher<IntentSenderRequest>[] launcher = new ActivityResultLauncher[1];
        launcher[0] = host.getActivityResultRegistry().register("eliza-google-authorization-" + UUID.randomUUID(),
            new ActivityResultContracts.StartIntentSenderForResult(), answer -> {
         launcher[0].unregister();
         if (cancellation.isCanceled() || answer.getResultCode() != Activity.RESULT_OK) { callback.failure("google_declined"); return; }
         try { authorized(Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(answer.getData()), callback); }
         catch (Exception refused) { callback.failure("google_declined"); }
        });
        launcher[0].launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
       })
       .addOnFailureListener(activity, unavailable -> callback.failure("google_unavailable"));
  } catch (Exception unavailable) { callback.failure("google_unavailable"); }
 }
 private static void authorized(AuthorizationResult result, Authorization callback) {
  String code = result.getServerAuthCode();
  if (code == null || !code.matches("[A-Za-z0-9/_.~-]{10,2048}")) callback.failure("google_unavailable");
  else callback.code(code);
 }
 public static void clear(Activity activity, Runnable completed) {
  if (activity == null || activity.isDestroyed()) { completed.run(); return; }
  try {
   CredentialManager.create(activity).clearCredentialStateAsync(
       new androidx.credentials.ClearCredentialStateRequest(), null, ContextCompat.getMainExecutor(activity),
       new CredentialManagerCallback<Void, androidx.credentials.exceptions.ClearCredentialException>() {
        @Override public void onResult(Void ignored) { completed.run(); }
        @Override public void onError(androidx.credentials.exceptions.ClearCredentialException ignored) { completed.run(); }
       });
  } catch (Exception unavailable) { completed.run(); }
 }
}
