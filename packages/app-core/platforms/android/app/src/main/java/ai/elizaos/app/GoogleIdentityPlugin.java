/**
 * Native Google identity bridge for the Play-distributed Cloud shell.
 * Credential Manager owns account selection; JavaScript receives only the
 * short-lived ID token that the Cloud backend verifies and consumes once.
 */
package ai.elizaos.app;

import android.os.CancellationSignal;
import androidx.credentials.ClearCredentialStateRequest;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.ClearCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

@CapacitorPlugin(name = "ElizaGoogleIdentity")
public final class GoogleIdentityPlugin extends Plugin {
    private static final String ERROR_CODE_CANCELLED = "GOOGLE_SIGN_IN_CANCELLED";
    private final Object operationLock = new Object();
    private CancellationSignal activeSignIn;

    @PluginMethod
    public void signIn(PluginCall call) {
        String serverClientId = call.getString("serverClientId", "").trim();
        String nonce = call.getString("nonce", "").trim();
        if (serverClientId.isEmpty() || nonce.length() < 32) {
            call.reject("Native Google sign-in is not configured.");
            return;
        }

        GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(serverClientId)
            .setNonce(nonce)
            .build();
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(option)
            .build();
        CredentialManager manager = CredentialManager.create(getActivity());
        CancellationSignal cancellationSignal = new CancellationSignal();
        synchronized (operationLock) {
            if (activeSignIn != null) activeSignIn.cancel();
            activeSignIn = cancellationSignal;
        }
        manager.getCredentialAsync(
            getActivity(),
            request,
            cancellationSignal,
            ContextCompat.getMainExecutor(getActivity()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse result) {
                    clearActiveSignIn(cancellationSignal);
                    Credential credential = result.getCredential();
                    if (!(credential instanceof CustomCredential custom) ||
                        !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(custom.getType())) {
                        call.reject("Google returned an unsupported credential.");
                        return;
                    }
                    try {
                        GoogleIdTokenCredential google = GoogleIdTokenCredential.createFrom(custom.getData());
                        JSObject response = new JSObject();
                        response.put("idToken", google.getIdToken());
                        call.resolve(response);
                    } catch (RuntimeException error) {
                        call.reject("Google returned an invalid credential.", error);
                    }
                }

                @Override
                public void onError(GetCredentialException error) {
                    clearActiveSignIn(cancellationSignal);
                    if (error instanceof GetCredentialCancellationException) {
                        call.reject("Google sign-in was cancelled.", ERROR_CODE_CANCELLED, error);
                        return;
                    }
                    call.reject("Google sign-in was cancelled or unavailable.", error);
                }
            }
        );
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        CancellationSignal cancellationSignal;
        synchronized (operationLock) {
            cancellationSignal = activeSignIn;
            activeSignIn = null;
        }
        if (cancellationSignal != null) cancellationSignal.cancel();
        JSObject response = new JSObject();
        response.put("cancelled", cancellationSignal != null);
        call.resolve(response);
    }

    @PluginMethod
    public void clearCredentialState(PluginCall call) {
        CredentialManager.create(getActivity()).clearCredentialStateAsync(
            new ClearCredentialStateRequest(),
            new CancellationSignal(),
            ContextCompat.getMainExecutor(getActivity()),
            new CredentialManagerCallback<Void, ClearCredentialException>() {
                @Override
                public void onResult(Void result) {
                    call.resolve(new JSObject());
                }

                @Override
                public void onError(ClearCredentialException error) {
                    call.reject("Google credential state could not be cleared.", error);
                }
            }
        );
    }

    private void clearActiveSignIn(CancellationSignal cancellationSignal) {
        synchronized (operationLock) {
            if (activeSignIn == cancellationSignal) activeSignIn = null;
        }
    }
}
