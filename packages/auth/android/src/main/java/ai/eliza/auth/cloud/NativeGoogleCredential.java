package ai.eliza.auth.cloud;

import android.app.Activity;
import android.os.CancellationSignal;
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
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

/** Android's Google account picker. ID tokens remain native and are never logged or bridged. */
public final class NativeGoogleCredential {
 private NativeGoogleCredential() {}
 public interface Callback {
  void token(String idToken);
  void failure(String code);
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
       activity.getMainExecutor(), new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
    @Override public void onResult(GetCredentialResponse response) {
     if (cancellation.isCanceled()) { callback.failure("cancelled"); return; }
     final String token;
     try {
      Credential credential = response.getCredential();
      if (!(credential instanceof CustomCredential)
          || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
       callback.failure("provider-refused");
       return;
      }
      token = GoogleIdTokenCredential.createFrom(credential.getData()).getIdToken();
      if (token == null || token.isEmpty() || token.length() > 32768) {
       callback.failure("provider-refused");
       return;
      }
     } catch (Exception invalidCredential) { callback.failure("provider-refused"); return; }
     callback.token(token);
    }
    @Override public void onError(GetCredentialException error) {
     callback.failure(error instanceof GetCredentialCancellationException ? "cancelled"
         : error instanceof NoCredentialException ? "google-account-unavailable" : "unavailable");
    }
   });
  } catch (Exception unavailable) { callback.failure("unavailable"); }
 }
 public static void clear(Activity activity, Runnable completed) {
  if (activity == null || activity.isDestroyed()) { completed.run(); return; }
  try {
   CredentialManager.create(activity).clearCredentialStateAsync(
       new androidx.credentials.ClearCredentialStateRequest(), null, activity.getMainExecutor(),
       new CredentialManagerCallback<Void, androidx.credentials.exceptions.ClearCredentialException>() {
        @Override public void onResult(Void ignored) { completed.run(); }
        @Override public void onError(androidx.credentials.exceptions.ClearCredentialException ignored) { completed.run(); }
       });
  } catch (Exception unavailable) { completed.run(); }
 }
}
