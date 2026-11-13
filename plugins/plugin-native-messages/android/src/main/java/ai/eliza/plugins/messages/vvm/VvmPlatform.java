package ai.eliza.plugins.messages.vvm;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.PersistableBundle;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telephony.TelephonyManager;
import android.telephony.VisualVoicemailSmsFilterSettings;

import java.io.Closeable;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * The real platform behind {@link VvmController}: telephony, the carrier's network and the worker thread.
 *
 * READ_PHONE_STATE, ACCESS_NETWORK_STATE, CHANGE_NETWORK_STATE and INTERNET are declared by the host
 * that ships this client, not by this library's manifest (other hosts of the library must not gain
 * them), so the permission lint check is answered here: every such call handles its refusal.
 */
@android.annotation.SuppressLint("MissingPermission")
@androidx.annotation.RequiresApi(29)
final class VvmPlatform {
 private VvmPlatform() {}

 static final class SystemRadio implements VvmController.Radio {
  private final Context context; private final VvmConfiguration config;
  SystemRadio(Context context, VvmConfiguration config) { this.context = context; this.config = config; }

  /** The telephony manager of one calling account, or the default subscription's for a null handle; null when there is none. */
  private TelephonyManager telephony(PhoneAccountHandle handle) {
   TelephonyManager telephony = context.getSystemService(TelephonyManager.class);
   return telephony == null || handle == null ? telephony : telephony.createForPhoneAccountHandle(handle);
  }
  @Override public boolean defaultDialer() {
   TelecomManager telecom = context.getSystemService(TelecomManager.class);
   return telecom != null && context.getPackageName().equals(telecom.getDefaultDialerPackage());
  }
  @Override public PersistableBundle carrierConfig(PhoneAccountHandle handle) {
   try { TelephonyManager telephony = telephony(handle); return telephony == null ? null : telephony.getCarrierConfig(); }
   catch (SecurityException denied) { return null; }
   catch (RuntimeException unavailable) { return null; }
  }
  @Override public boolean filter(PhoneAccountHandle handle, String clientPrefix) {
   try {
    TelephonyManager telephony = telephony(handle);
    if (telephony == null) return false;
    telephony.setVisualVoicemailSmsFilterSettings(clientPrefix == null ? null : new VisualVoicemailSmsFilterSettings.Builder().setClientPrefix(clientPrefix).build());
    return true;
   } catch (RuntimeException refused) { return false; }
  }
  @Override public void send(VvmAccount account, String number, int port, String text) {
   TelephonyManager telephony = telephony(account.handle);
   if (telephony == null || account.handle == null) throw new IllegalStateException("No telephony for this account");
   // Explicit, immutable and addressed to the host's own receiver: only the radio's result code comes back.
   Intent result = new Intent(VisualVoicemailReceiver.ACTION_REQUEST_SENT).setClass(context, config.receiver).setData(Uri.fromParts("vvm", account.slot, null))
     .putExtra(VisualVoicemailReceiver.EXTRA_COMPONENT, account.component).putExtra(VisualVoicemailReceiver.EXTRA_ID, account.id);
   PendingIntent sent = PendingIntent.getBroadcast(context, 0, result, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
   try { telephony.sendVisualVoicemailSms(number, port, text, sent); }
   catch (SecurityException denied) { throw new IllegalStateException("Voicemail SMS refused"); }
  }
 }

 /**
  * Connects to the carrier's IMAP server. With {@code vvm_cellular_data_required_bool}, or whenever
  * the carrier configured no TLS, the session runs only over a cellular network requested for this
  * subscription (the name is resolved and the socket opened on that network), and the request is
  * given back when the session closes. So a plaintext login never leaves over Wi-Fi. With TLS the
  * platform's trust store and the server's host name are both checked; there is no fallback.
  */
 static final class NetworkTransport implements VvmController.Transport {
  static final int NETWORK_MILLIS = 30_000, CONNECT_MILLIS = 15_000, READ_MILLIS = 30_000, MAX_ADDRESSES = 4;
  static final long SESSION_MILLIS = 5 * 60_000;
  private final Context context;
  NetworkTransport(Context context) { this.context = context; }

  @Override public ImapClient connect(VvmAccount account, VvmAccount.Credentials credentials, CarrierVvm carrier) throws IOException {
   ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
   if (connectivity == null) throw new VvmController.Unreachable(false);
   boolean cellular = carrier.cellularRequired || !carrier.tls;
   Network network; Closeable release = null;
   if (cellular) {
    AtomicReference<Network> found = new AtomicReference<>();
    CountDownLatch answered = new CountDownLatch(1);
    ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
     @Override public void onAvailable(Network available) { found.compareAndSet(null, available); answered.countDown(); }
     @Override public void onUnavailable() { answered.countDown(); }
    };
    NetworkRequest.Builder request = new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR).addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    int subscription = subscription(account.handle);
    if (subscription >= 0 && Build.VERSION.SDK_INT >= 30) request.setNetworkSpecifier(new android.net.TelephonyNetworkSpecifier.Builder().setSubscriptionId(subscription).build());
    try { connectivity.requestNetwork(request.build(), callback, NETWORK_MILLIS); }
    catch (SecurityException denied) { throw new VvmController.Unreachable(true); }
    catch (RuntimeException refused) { throw new VvmController.Unreachable(true); }
    release = () -> { try { connectivity.unregisterNetworkCallback(callback); } catch (RuntimeException alreadyReleased) { /* nothing held */ } };
    try { answered.await(NETWORK_MILLIS + 5_000, TimeUnit.MILLISECONDS); }
    catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
    network = found.get();
    if (network == null) { release.close(); throw new VvmController.Unreachable(true); }
   } else {
    try { network = connectivity.getActiveNetwork(); }
    catch (SecurityException denied) { throw new VvmController.Unreachable(false); }
    if (network == null) throw new VvmController.Unreachable(false);
   }
   Socket socket = null;
   try {
    InetAddress[] addresses = network.getAllByName(credentials.server);
    IOException last = new IOException("No address for the voicemail server");
    for (int i = 0; i < addresses.length && i < MAX_ADDRESSES && socket == null; i++) {
     Socket attempt = network.getSocketFactory().createSocket();
     try { attempt.connect(new InetSocketAddress(addresses[i], credentials.port), CONNECT_MILLIS); socket = attempt; }
     catch (IOException failed) { last = failed; closeQuietly(attempt); }
    }
    if (socket == null) throw last;
    if (carrier.tls) socket = tls(socket, credentials.server, credentials.port, (SSLSocketFactory) SSLSocketFactory.getDefault());
    return new ImapClient(socket, READ_MILLIS, SESSION_MILLIS, release);
   } catch (IOException | RuntimeException failed) {
    closeQuietly(socket);
    if (release != null) release.close();
    if (failed instanceof ImapClient.ImapException) throw (ImapClient.ImapException) failed;
    // The cause may carry the server's address; only the fact of the failure leaves here.
    throw new IOException("Voicemail server unreachable");
   }
  }

  /** The subscription behind a calling account, or -1 when the platform cannot say (then the default data SIM's cellular network is asked for). */
  private int subscription(PhoneAccountHandle handle) {
   if (handle == null || Build.VERSION.SDK_INT < 30) return -1;
   try {
    TelephonyManager telephony = context.getSystemService(TelephonyManager.class);
    return telephony == null ? -1 : telephony.getSubscriptionId(handle);
   } catch (RuntimeException unavailable) { return -1; }
  }
 }

 /** TLS over a connected socket with the factory's trust decisions and the server's host name verified. */
 static Socket tls(Socket plain, String host, int port, SSLSocketFactory factory) throws IOException {
  if (factory == null) throw new IOException("TLS unavailable");
  SSLSocket socket = (SSLSocket) factory.createSocket(plain, host, port, true);
  SSLParameters parameters = socket.getSSLParameters();
  parameters.setEndpointIdentificationAlgorithm("HTTPS");
  socket.setSSLParameters(parameters);
  socket.setSoTimeout(NetworkTransport.READ_MILLIS);
  socket.startHandshake();
  return socket;
 }
 private static void closeQuietly(Socket socket) { if (socket != null) try { socket.close(); } catch (IOException ignored) { /* nothing to recover */ } }

 /** One daemon worker thread; at most {@link #MAX_PENDING} pieces of work wait or are scheduled at once. */
 static final class Worker implements VvmController.Scheduler {
  static final int MAX_PENDING = 32;
  private final AtomicInteger pending = new AtomicInteger();
  private final ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(1, runnable -> {
   Thread thread = new Thread(runnable, "visual-voicemail");
   thread.setDaemon(true);
   return thread;
  });
  Worker() { executor.setKeepAliveTime(30, TimeUnit.SECONDS); executor.allowCoreThreadTimeOut(true); executor.setRemoveOnCancelPolicy(true); }
  @Override public boolean run(Runnable work) { return later(0, work); }
  @Override public boolean later(long delayMillis, Runnable work) {
   if (pending.incrementAndGet() > MAX_PENDING) { pending.decrementAndGet(); return false; }
   try {
    executor.schedule(() -> { try { work.run(); } catch (RuntimeException failed) { /* each piece of work reports its own failure */ } finally { pending.decrementAndGet(); } },
      delayMillis, TimeUnit.MILLISECONDS);
    return true;
   } catch (RuntimeException rejected) { pending.decrementAndGet(); return false; }
  }
 }
}
