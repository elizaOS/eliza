/** Renders the Android play export Java source for cloud-safe mobile builds. */

/** Standard Storage Access Framework export saver for the Play Cloud shell. */
export function cloudSafePlayExportPluginJava(androidPackage) {
  return `package ${androidPackage};

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;

@CapacitorPlugin(name = "ElizaPlayExport")
public final class ElizaPlayExportPlugin extends Plugin {
    private static final int MAX_EXPORT_BYTES = 32 * 1024 * 1024;
    private static final String PRODUCTION_API = "https://api.eliza.app";
    private static final String PRODUCTION_APP = "https://cloud.eliza.app";
    private static final String STAGING_API = "https://api-staging.eliza.app";
    private static final String STAGING_APP = "https://cloud-staging.eliza.app";
    private static final String STATUS_PATH = "/api/public/account-deletion/export";
    private static final String CONFIRMATION = "{\\"confirmation\\":\\"EXPORT MY DATA\\"}";
    private static final String CAPABILITY_PATTERN = "^[A-Za-z0-9_-]{43}$";
    private static final String DIGEST_PATTERN = "^[A-Fa-f0-9]{64}$";

    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final Map<String, PendingExport> pendingExports = new ConcurrentHashMap<>();

    private static final class PendingExport {
        final byte[] bytes;
        final String digest;

        PendingExport(byte[] bytes, String digest) {
            this.bytes = bytes;
            this.digest = digest;
        }
    }

    @PluginMethod
    public void saveExport(PluginCall call) {
        String apiBase = call.getString("apiBase", "");
        String appOrigin = call.getString("appOrigin", "");
        String recoveryCredential = call.getString("recoveryCredential", "");
        if (!isCanonicalPair(apiBase, appOrigin)) {
            call.reject("The account export authority is invalid.", "EXPORT_AUTHORITY_INVALID");
            return;
        }
        if (!recoveryCredential.matches(CAPABILITY_PATTERN)) {
            call.reject("Recovery access is invalid.", "EXPORT_CREDENTIAL_INVALID");
            return;
        }

        ioExecutor.execute(() -> {
            try {
                PendingExport export = download(apiBase, appOrigin, recoveryCredential);
                pendingExports.put(call.getCallbackId(), export);
                getBridge().executeOnMainThread(() -> {
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("application/json");
                    intent.putExtra(Intent.EXTRA_TITLE, "eliza-account-export.json");
                    startActivityForResult(call, intent, "saveExportResult");
                });
            } catch (Exception error) {
                getBridge().executeOnMainThread(() ->
                    call.reject("The encrypted account export could not be downloaded.",
                        "EXPORT_DOWNLOAD_FAILED", error));
            }
        });
    }

    @ActivityCallback
    private void saveExportResult(PluginCall call, ActivityResult result) {
        PendingExport export = pendingExports.remove(call.getCallbackId());
        if (export == null) {
            call.reject("The pending account export is unavailable.", "EXPORT_SAVE_UNAVAILABLE");
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            Arrays.fill(export.bytes, (byte) 0);
            JSObject response = new JSObject();
            response.put("saved", false);
            call.resolve(response);
            return;
        }
        Uri destination = result.getData().getData();
        if (destination == null) {
            Arrays.fill(export.bytes, (byte) 0);
            call.reject("No export destination was selected.", "EXPORT_SAVE_UNAVAILABLE");
            return;
        }
        ioExecutor.execute(() -> {
            try (OutputStream output = getContext().getContentResolver().openOutputStream(destination, "w")) {
                if (output == null) throw new IOException("destination stream is unavailable");
                output.write(export.bytes);
                output.flush();
                JSObject response = new JSObject();
                response.put("saved", true);
                response.put("contentDigest", export.digest);
                getBridge().executeOnMainThread(() -> call.resolve(response));
            } catch (IOException error) {
                getBridge().executeOnMainThread(() ->
                    call.reject("The account export could not be saved.",
                        "EXPORT_SAVE_FAILED", error));
            } finally {
                Arrays.fill(export.bytes, (byte) 0);
            }
        });
    }

    private PendingExport download(
            String apiBase,
            String appOrigin,
            String recoveryCredential) throws IOException, GeneralSecurityException {
        HttpsURLConnection connection = null;
        try {
            connection = (HttpsURLConnection) new URL(apiBase + STATUS_PATH).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(120_000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Origin", appOrigin);
            connection.setRequestProperty("x-eliza-csrf", "1");
            connection.setRequestProperty("X-Account-Deletion-Recovery", recoveryCredential);
            connection.setDoOutput(true);
            byte[] body = CONFIRMATION.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }
            if (connection.getResponseCode() != 200) {
                throw new IOException("account export returned HTTP " + connection.getResponseCode());
            }
            if (connection.getContentLengthLong() > MAX_EXPORT_BYTES) {
                throw new IOException("account export exceeds the supported size");
            }
            String expectedDigest = connection.getHeaderField(
                "X-Account-Deletion-Export-SHA256");
            if (expectedDigest == null || !expectedDigest.matches(DIGEST_PATTERN)) {
                throw new GeneralSecurityException("account export digest is missing");
            }
            byte[] bytes;
            try (InputStream input = connection.getInputStream()) {
                bytes = readBounded(input);
            }
            String actualDigest = sha256(bytes);
            if (!MessageDigest.isEqual(
                    actualDigest.getBytes(StandardCharsets.US_ASCII),
                    expectedDigest.toLowerCase(Locale.ROOT).getBytes(StandardCharsets.US_ASCII))) {
                Arrays.fill(bytes, (byte) 0);
                throw new GeneralSecurityException("account export digest does not match");
            }
            return new PendingExport(bytes, actualDigest);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static byte[] readBounded(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > MAX_EXPORT_BYTES) {
                throw new IOException("account export exceeds the supported size");
            }
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static String sha256(byte[] bytes) throws GeneralSecurityException {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte value : digest) hex.append(String.format("%02x", value & 0xff));
        return hex.toString();
    }

    private static boolean isCanonicalPair(String apiBase, String appOrigin) {
        return (PRODUCTION_API.equals(apiBase) && PRODUCTION_APP.equals(appOrigin))
            || (STAGING_API.equals(apiBase) && STAGING_APP.equals(appOrigin));
    }

    @Override
    protected void handleOnDestroy() {
        ioExecutor.shutdownNow();
        for (PendingExport export : pendingExports.values()) {
            Arrays.fill(export.bytes, (byte) 0);
        }
        pendingExports.clear();
        super.handleOnDestroy();
    }
}
`;
}
