// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Connect my Google mail and calendar with the same sign-in"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.securestore.google.NativeGoogleAuthorization;
import ai.eliza.plugins.signin.CodeSignIn.Answer;
import ai.eliza.plugins.signin.CodeSignIn.Checked;
import ai.eliza.plugins.signin.SignInPolicy.Failure;
import ai.eliza.plugins.signin.SignInPolicy.CloudReply;
import ai.eliza.plugins.signin.SignInPolicy.PickerResult;
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
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import java.io.IOException;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import org.json.JSONObject;

public final class GoogleSignIn {
  public static final String CHALLENGE = "/api/v1/auth/google/native/challenge";
  public static final String MOBILE_GOOGLE = "/api/v1/app-auth/mobile/google";
  public static final String CONNECT_NATIVE = "/api/v1/eliza/google/connect/native";

  public static final class SecretServerCode {
    private String value;
    SecretServerCode(String value) { this.value = value; }
    synchronized String peek() { return value; }
    synchronized String take() { String once = value; value = null; return once; }
    public synchronized void drop() { value = null; }
    @Override public String toString() { return "SecretServerCode[redacted]"; }
  }

  public record Challenge(String challengeId, String nonce, String serverClientId, long expiresAt, String verifier) {
    @Override public String toString() { return "Challenge[" + challengeId + ", expiresAt=" + expiresAt + "]"; }
  }

  public sealed interface Picked {
    record Token(String idToken, String account) implements Picked {
      @Override public String toString() { return "Token[redacted]"; }
    }
    record NotPicked(PickerResult result) implements Picked {}
  }

  public sealed interface Authorized {
    record Code(SecretServerCode code) implements Authorized {}
    record Declined() implements Authorized {}
  }

  public interface Browser {
    void open(int attempt, SignInRegistration.Environment environment, boolean reauthenticate, Returned returned);

    void cancel(int attempt);
  }

  public interface Returned {
    void exchanged(int credentialAttempt, Checked answer);

    void refused(Failure problem);
  }

  private final CodeSignIn.Http http;
  private final SignInRegistration registration;

  public GoogleSignIn(CodeSignIn.Http http, SignInRegistration registration) { this.http = http; this.registration = registration; }

  public Challenge challenge(SignInRegistration.Environment environment, long now) {
    String verifier = SignInPolicy.newVerifier();
    Answer answer;
    try {
      answer = http.post(environment.apiOrigin + CHALLENGE, CodeSignIn.json("clientId", registration.clientId, "environment", environment.name,
        "redirectUri", environment.redirectUri, "codeChallenge", SignInPolicy.s256(verifier), "codeChallengeMethod", "S256"), null);
    } catch (IOException | RuntimeException unanswered) {
      return null;
    }
    if (!answer.ok()) return null;
    JSONObject body = answer.body();
    String challengeId = body.optString("challengeId", ""), nonce = body.optString("nonce", ""), serverClientId = body.optString("serverClientId", "");
    long expiresAt = SignInPolicy.challengeExpiresAt(body.opt("expiresAt"), now);
    if (challengeId.isEmpty() || challengeId.length() > 256 || !SignInPolicy.validNonce(nonce)
        || !SignInPolicy.validServerClientId(serverClientId) || expiresAt == 0) return null;
    return new Challenge(challengeId, nonce, serverClientId, expiresAt, verifier);
  }

  public Checked signIn(SignInRegistration.Environment environment, Challenge challenge, String idToken, SecretServerCode serverCode, long now) {
    String state = SignInPolicy.newState(), verifier = SignInPolicy.newVerifier();
    JSONObject body = CodeSignIn.json("clientId", registration.clientId, "environment", environment.name, "redirectUri", environment.redirectUri,
      "state", state, "codeVerifier", verifier, "identity", CodeSignIn.json("challengeId", challenge.challengeId(), "idToken", idToken,
        "codeVerifier", challenge.verifier()));
    String code = serverCode == null ? null : serverCode.peek();
    if (code != null) put(body, "serverAuthCode", code);
    Answer answer;
    try { answer = http.post(environment.apiOrigin + MOBILE_GOOGLE, body, null); }
    catch (IOException | RuntimeException unanswered) { return new Checked.NotChecked(new CloudReply.Unanswered()); }
    return CodeSignIn.checkedGoogle(answer, state, verifier, now);
  }

  public boolean connectNative(SignInRegistration.Environment environment, String key, SecretServerCode serverCode) {
    String code = serverCode == null ? null : serverCode.take();
    if (code == null) return false;
    try {
      Answer answer = http.post(environment.apiOrigin + CONNECT_NATIVE, CodeSignIn.json("serverAuthCode", code), key);
      return answer.ok() && answer.body().optBoolean("connected", false);
    } catch (IOException | RuntimeException unanswered) {
      return false;
    }
  }

  private static void put(JSONObject body, String key, String value) {
    try { body.put(key, value); } catch (org.json.JSONException invalid) { throw new IllegalArgumentException(invalid); }
  }

  private static Picked notPicked(boolean dismissed) {
    return new Picked.NotPicked(dismissed ? PickerResult.DISMISSED : PickerResult.NO_GOOGLE_ACCOUNT);
  }

  public static void pick(Activity activity, Challenge challenge, CancellationSignal cancellation, Consumer<Picked> done) {
    if (activity == null || activity.isFinishing() || activity.isDestroyed()) { done.accept(notPicked(false)); return; }
    try {
      GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(challenge.serverClientId()).setNonce(challenge.nonce()).build();
      GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
      CredentialManager.create(activity).getCredentialAsync(activity, request, cancellation, ContextCompat.getMainExecutor(activity),
        new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
          @Override public void onResult(GetCredentialResponse response) {
            if (cancellation.isCanceled()) { done.accept(notPicked(true)); return; }
            Credential credential = response.getCredential();
            if (!(credential instanceof CustomCredential) || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
              done.accept(notPicked(false));
              return;
            }
            GoogleIdTokenCredential google;
            try { google = GoogleIdTokenCredential.createFrom(credential.getData()); }
            catch (RuntimeException malformed) { done.accept(notPicked(false)); return; }
            String token = google.getIdToken();
            done.accept(!SignInPolicy.validIdToken(token) || google.getId().isEmpty() ? notPicked(false) : new Picked.Token(token, google.getId()));
          }

          @Override public void onError(GetCredentialException error) {
            done.accept(notPicked(error instanceof GetCredentialCancellationException));
          }
        });
    } catch (RuntimeException unavailable) {
      done.accept(notPicked(false));
    }
  }

  public static void authorize(Activity activity, Challenge challenge, String account, List<String> scopes, CancellationSignal cancellation,
      Consumer<Authorized> done) {
    if (!(activity instanceof ComponentActivity host) || activity.isFinishing() || activity.isDestroyed() || scopes.isEmpty()) {
      done.accept(new Authorized.Declined());
      return;
    }
    try {
      AuthorizationRequest request = NativeGoogleAuthorization.request(challenge.serverClientId(), account, scopes);
      Identity.getAuthorizationClient(activity).authorize(request)
        .addOnSuccessListener(result -> {
          if (cancellation.isCanceled()) { done.accept(new Authorized.Declined()); return; }
          if (!result.hasResolution()) { done.accept(authorized(result)); return; }
          @SuppressWarnings("unchecked") ActivityResultLauncher<IntentSenderRequest>[] launcher = new ActivityResultLauncher[1];
          launcher[0] = host.getActivityResultRegistry().register("eliza-google-scopes-" + UUID.randomUUID(),
            new ActivityResultContracts.StartIntentSenderForResult(), answer -> {
              launcher[0].unregister();
              if (cancellation.isCanceled() || answer.getResultCode() != Activity.RESULT_OK) { done.accept(new Authorized.Declined()); return; }
              try { done.accept(authorized(Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(answer.getData()))); }
              catch (ApiException refused) { done.accept(new Authorized.Declined()); }
            });
          launcher[0].launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
        })
        .addOnFailureListener(unavailable -> done.accept(new Authorized.Declined()));
    } catch (RuntimeException unavailable) {
      done.accept(new Authorized.Declined());
    }
  }

  private static Authorized authorized(AuthorizationResult result) {
    String code = result.getServerAuthCode();
    return SignInPolicy.validServerCode(code) ? new Authorized.Code(new SecretServerCode(code)) : new Authorized.Declined();
  }
}
