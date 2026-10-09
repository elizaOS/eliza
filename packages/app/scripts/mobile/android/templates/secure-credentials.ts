/** Renders the Android secure credentials Java source for cloud-safe mobile builds. */

/** Android Keystore-backed bearer storage for the Play Cloud client. */
export function cloudSafeSecureCredentialsPluginJava(androidPackage) {
  return `package ${androidPackage};

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import org.json.JSONObject;

@CapacitorPlugin(name = "ElizaSecureCredentials")
public final class ElizaSecureCredentialsPlugin extends Plugin {
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "ai.elizaos.app.android_cloud_token_key_v1";
    private static final String PREFERENCES = "eliza_secure_credentials_v1";
    private static final String SESSION_CIPHERTEXT = "steward_token_ciphertext";
    private static final String PENDING_LOGIN_CIPHERTEXT = "mobile_login_ciphertext";
    private static final String ADMISSION_CIPHERTEXT = "account_deletion_admission_ciphertext";
    private static final String STATUS_CIPHERTEXT = "account_deletion_status_ciphertext";
    private static final String RECOVERY_CIPHERTEXT = "account_deletion_recovery_ciphertext";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String LOCAL_APP_ORIGIN = "https://localhost";
    private static final int GCM_TAG_BITS = 128;
    private static final int MAX_TOKEN_BYTES = 16 * 1024;
    private static final long WEBVIEW_URL_TIMEOUT_SECONDS = 2L;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @PluginMethod
    public synchronized void get(PluginCall call) {
        if (!requireExactLocalOrigin(call)) return;
        String preferenceKey = preferenceKey(call);
        if (preferenceKey == null) return;
        String encoded = preferences().getString(preferenceKey, null);
        if (encoded == null) {
            JSObject result = new JSObject();
            result.put("value", JSONObject.NULL);
            call.resolve(result);
            return;
        }
        try {
            String[] parts = encoded.split(":", -1);
            if (parts.length != 2) throw new GeneralSecurityException("invalid ciphertext envelope");
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, loadOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            String value = new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
            JSObject result = new JSObject();
            result.put("value", value);
            call.resolve(result);
        } catch (GeneralSecurityException | IllegalArgumentException error) {
            preferences().edit().remove(preferenceKey).apply();
            call.reject("Secure credential storage is unavailable.", "SECURE_CREDENTIAL_UNAVAILABLE", error);
        }
    }

    @PluginMethod
    public synchronized void set(PluginCall call) {
        if (!requireExactLocalOrigin(call)) return;
        String preferenceKey = preferenceKey(call);
        if (preferenceKey == null) return;
        String value = call.getString("value");
        if (value == null || value.trim().isEmpty()) {
            call.reject("A non-empty credential is required.", "SECURE_CREDENTIAL_INVALID");
            return;
        }
        byte[] plaintext = value.getBytes(StandardCharsets.UTF_8);
        if (plaintext.length > MAX_TOKEN_BYTES) {
            call.reject("The credential is too large.", "SECURE_CREDENTIAL_INVALID");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, loadOrCreateKey());
            String encoded = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                    + ":"
                    + Base64.encodeToString(cipher.doFinal(plaintext), Base64.NO_WRAP);
            if (!preferences().edit().putString(preferenceKey, encoded).commit()) {
                call.reject("Secure credential storage could not be committed.", "SECURE_CREDENTIAL_UNAVAILABLE");
                return;
            }
            call.resolve();
        } catch (GeneralSecurityException error) {
            call.reject("Secure credential storage is unavailable.", "SECURE_CREDENTIAL_UNAVAILABLE", error);
        }
    }

    @PluginMethod
    public synchronized void remove(PluginCall call) {
        if (!requireExactLocalOrigin(call)) return;
        String preferenceKey = preferenceKey(call);
        if (preferenceKey == null) return;
        if (!preferences().edit().remove(preferenceKey).commit()) {
            call.reject("Secure credential storage could not be cleared.", "SECURE_CREDENTIAL_UNAVAILABLE");
            return;
        }
        call.resolve();
    }

    private boolean requireExactLocalOrigin(PluginCall call) {
        if (getBridge() == null || !LOCAL_APP_ORIGIN.equals(getBridge().getLocalUrl())) {
            call.reject("Secure credentials are available only to the packaged app.", "SECURE_CREDENTIAL_ORIGIN_DENIED");
            return false;
        }
        WebView webView = getBridge().getWebView();
        String currentUrl = currentWebViewUrl(webView);
        Uri current = currentUrl == null ? null : Uri.parse(currentUrl);
        if (current == null
                || !"https".equals(current.getScheme())
                || !"localhost".equals(current.getHost())
                || current.getPort() != -1) {
            call.reject("Secure credentials are available only to the packaged app.", "SECURE_CREDENTIAL_ORIGIN_DENIED");
            return false;
        }
        return true;
    }

    private String currentWebViewUrl(WebView webView) {
        if (webView == null) return null;
        if (Looper.myLooper() == Looper.getMainLooper()) return webView.getUrl();

        CountDownLatch completed = new CountDownLatch(1);
        AtomicReference<String> currentUrl = new AtomicReference<>();
        mainHandler.post(() -> {
            try {
                currentUrl.set(webView.getUrl());
            } finally {
                completed.countDown();
            }
        });
        try {
            if (!completed.await(WEBVIEW_URL_TIMEOUT_SECONDS, TimeUnit.SECONDS)) return null;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return null;
        }
        return currentUrl.get();
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private String preferenceKey(PluginCall call) {
        String slot = call.getString("slot", "credential");
        if ("credential".equals(slot)) return SESSION_CIPHERTEXT;
        if ("pending_login".equals(slot)) return PENDING_LOGIN_CIPHERTEXT;
        if ("account_deletion_admission".equals(slot)) return ADMISSION_CIPHERTEXT;
        if ("account_deletion_status".equals(slot)) return STATUS_CIPHERTEXT;
        if ("account_deletion_recovery".equals(slot)) return RECOVERY_CIPHERTEXT;
        call.reject("The secure credential slot is invalid.", "SECURE_CREDENTIAL_INVALID");
        return null;
    }

    private SecretKey loadOrCreateKey() throws GeneralSecurityException {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        try {
            keyStore.load(null);
        } catch (IOException error) {
            throw new GeneralSecurityException("Android Keystore could not be loaded", error);
        }
        java.security.Key existing = keyStore.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }
}
`;
}
