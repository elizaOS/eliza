/**
 * Relays the verified browser extension to the same-UID agent over a private
 * abstract socket. Chromium authenticates the extension; Binder callers must
 * additionally match the configured Chromium signing certificate. The relay
 * preserves native-message frames and never exports a TCP debugging endpoint.
 */
package ai.elizaos.app;

import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Binder;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Process;
import android.os.RemoteException;
import android.util.Log;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import ai.eliza.plugins.browsersurface.ChromiumBrowserIdentity;
import java.util.List;
import org.chromium.chrome.browser.extensions.api.messaging.IBrowserNativeMessageService;
import org.chromium.chrome.browser.extensions.api.messaging.IConnectExtensionCallback;
import org.chromium.chrome.browser.extensions.api.messaging.IConnectPortCallback;
import org.chromium.chrome.browser.extensions.api.messaging.IExtensionNativeMessageCallback;
import org.chromium.chrome.browser.extensions.api.messaging.IExtensionNativeMessagePort;
import org.chromium.chrome.browser.extensions.api.messaging.IExtensionNativeMessageService;
import org.chromium.chrome.browser.extensions.api.messaging.MessagePayload;

public final class BrowserNativeMessagingService extends Service {
    private static final String EXTENSION_ID = "pmldpcoefklbdbgmggcejkfoinmjfeio";
    private static final String BROWSER = BuildConfig.ELIZA_CHROMIUM_PACKAGE_NAME;
    private static final String SOCKET = "ai.elizaos.app.browser.native";
    // Binder has a shared transaction limit; wire producers must chunk larger JSON messages.
    private static final int MAX_FRAME_BYTES = 64 * 1024;
    private volatile Relay active;

    private void requireBrowser() {
        String[] packages = getPackageManager().getPackagesForUid(Binder.getCallingUid());
        if (!ChromiumBrowserIdentity.isTrustedCaller(packages, BROWSER, BuildConfig.ELIZA_CHROMIUM_CERT_SHA256,
                (packageName, certificate) -> getPackageManager().hasSigningCertificate(
                    packageName, certificate, PackageManager.CERT_INPUT_SHA256))) {
            throw new SecurityException("Browser package or signing certificate mismatch");
        }
    }

    private final IBrowserNativeMessageService.Stub browserService = new IBrowserNativeMessageService.Stub() {
        @Override
        public void connectExtension(String extensionId, Bundle info, IConnectExtensionCallback callback) throws RemoteException {
            requireBrowser();
            if (!EXTENSION_ID.equals(extensionId) || info == null ||
                    (!info.getBoolean("isVerified") && !BuildConfig.DEBUG)) {
                callback.onError("This browser extension is not authorized");
                return;
            }
            callback.onSuccess(new IExtensionNativeMessageService.Stub() {
                private Relay owned;
                @Override public void closeConnection() {
                    requireBrowser();
                    synchronized (BrowserNativeMessagingService.this) {
                        if (owned != null) owned.close();
                    }
                }
                @Override public void connectPort(IExtensionNativeMessageCallback receiver, IConnectPortCallback portCallback) throws RemoteException {
                    requireBrowser();
                    synchronized (BrowserNativeMessagingService.this) {
                        if (active != null) {
                            portCallback.onError("A browser profile is already connected");
                            return;
                        }
                        try {
                            Relay relay = new Relay(receiver);
                            active = relay;
                            owned = relay;
                            receiver.asBinder().linkToDeath(relay::close, 0);
                            portCallback.onSuccess(relay.port);
                            relay.start();
                        } catch (IOException | RemoteException error) {
                            // error-policy:J1 Socket allocation failure rejects the native port.
                            if (owned != null) owned.close();
                            portCallback.onError("The private browser transport is unavailable");
                        }
                    }
                }
            });
        }
    };

    @Override public IBinder onBind(Intent intent) { return browserService; }
    @Override public void onDestroy() {
        synchronized (this) { if (active != null) active.close(); }
        super.onDestroy();
    }

    private final class Relay {
        final IExtensionNativeMessageCallback receiver;
        final LocalServerSocket server;
        final List<byte[]> pending = new ArrayList<>();
        LocalSocket client;
        OutputStream output;
        volatile boolean closed;

        Relay(IExtensionNativeMessageCallback receiver) throws IOException {
            this.receiver = receiver;
            server = new LocalServerSocket(SOCKET);
        }

        final IExtensionNativeMessagePort.Stub port = new IExtensionNativeMessagePort.Stub() {
            @Override public void postMessage(MessagePayload payload, Bundle extras) {
                requireBrowser();
                synchronized (Relay.this) {
                    if (closed) return;
                    if (payload == null || payload.getTag() != MessagePayload.inlineBytes) {
                        close();
                        return;
                    }
                    byte[] bytes = payload.getInlineBytes();
                    if (bytes == null || bytes.length == 0 || bytes.length > MAX_FRAME_BYTES) {
                        close();
                        return;
                    }
                    try {
                        if (output == null) pending.add(bytes.clone());
                        else writeFrame(output, bytes);
                    } catch (IOException error) {
                        // error-policy:J1 A broken transport disconnects instead of losing a receipt.
                        close();
                    }
                }
            }
            @Override public void disconnect() { requireBrowser(); close(); }
        };

        void start() {
            new Thread(() -> {
                try {
                    while (!closed) {
                        LocalSocket candidate = server.accept();
                        if (candidate.getPeerCredentials().getUid() != Process.myUid()) {
                            candidate.close();
                            continue;
                        }
                        synchronized (this) {
                            if (closed) { candidate.close(); return; }
                            client = candidate;
                            output = candidate.getOutputStream();
                            for (byte[] bytes : pending) writeFrame(output, bytes);
                            pending.clear();
                        }
                        InputStream input = candidate.getInputStream();
                        while (!closed) {
                            byte[] header = readExactly(input, 4);
                            long length = (header[0] & 255L) | ((header[1] & 255L) << 8) |
                                    ((header[2] & 255L) << 16) | ((header[3] & 255L) << 24);
                            if (length == 0 || length > MAX_FRAME_BYTES) throw new IOException("Native frame exceeds Binder transport limit; use chunk frames");
                            MessagePayload message = new MessagePayload();
                            message.setInlineBytes(readExactly(input, (int) length));
                            receiver.onMessage(message, new Bundle());
                        }
                    }
                } catch (IOException | RemoteException error) {
                    // error-policy:J1 EOF, invalid frames and binder failure terminate the connection.
                    Log.w("BrowserNativeMessaging", "Private browser connection ended: " + error.getClass().getSimpleName() + ": " + error.getMessage());
                } finally { close(); }
            }, "ElizaBrowserNativeMessaging").start();
        }

        synchronized void close() {
            if (closed) return;
            closed = true;
            pending.clear();
            try {
                server.close();
                if (client != null) client.close();
                receiver.onDisconnect();
            } catch (IOException | RemoteException error) {
                // error-policy:J6 The channel is already closed; teardown cannot restore it.
                Log.w("BrowserNativeMessaging", "Browser transport teardown failed", error);
            }
            if (active == this) active = null;
        }
    }

    private static byte[] readExactly(InputStream input, int length) throws IOException {
        byte[] bytes = new byte[length];
        int offset = 0;
        while (offset < length) {
            int count = input.read(bytes, offset, length - offset);
            if (count < 0) throw new IOException("Native messaging peer disconnected");
            offset += count;
        }
        return bytes;
    }

    private static void writeFrame(OutputStream output, byte[] bytes) throws IOException {
        output.write(new byte[] { (byte) bytes.length, (byte) (bytes.length >>> 8),
                (byte) (bytes.length >>> 16), (byte) (bytes.length >>> 24) });
        output.write(bytes);
        output.flush();
    }
}
