package ai.eliza.plugins.messages.vvm;

import android.content.Context;
import android.os.PersistableBundle;
import android.provider.VoicemailContract.Status;
import android.telecom.PhoneAccountHandle;
import android.util.Log;

import java.io.IOException;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * The visual-voicemail client's decisions, apart from the platform: what to do when the SIM comes
 * into service, when the carrier answers or notifies by SMS, when the SIM leaves, when the host
 * stops being the dialer, and when audio or a sync is asked for. The host's service and receiver
 * only forward to it.
 *
 * Every entry point runs its work on the one worker of {@link Scheduler} and calls {@code done}
 * exactly once, whether the work ran, failed or was refused, so the platform task behind it is
 * always finished. Before anything else each entry checks that the host is still the default
 * dialer; when it is not, everything this source stored (rows, status, IMAP accounts) is removed.
 *
 * A sync that fails for a passing reason (no network, no answer, a broken connection) is tried
 * again after each of {@link #RETRY_DELAYS} and then given up; a refused login, an unreadable
 * server or a broken bound is not retried. Nothing here logs a number, a credential, a server
 * address or message content.
 */
@androidx.annotation.RequiresApi(29)
public final class VvmController {
 private static final String TAG = "VisualVoicemail";
 /** Waits before the second, third and fourth attempt of one sync. There is no fifth. */
 static final long[] RETRY_DELAYS = { 15_000, 60_000, 240_000 };

 /** The radio-facing platform calls, for one calling account. */
 interface Radio {
  boolean defaultDialer();
  /** The subscription's carrier configuration; null when it cannot be read. */
  PersistableBundle carrierConfig(PhoneAccountHandle handle);
  /** Sets the visual-voicemail SMS filter to a client prefix, or clears it (null). False when the platform refused. */
  boolean filter(PhoneAccountHandle handle, String clientPrefix);
  /** Sends one visual-voicemail request; throws when the platform refused it. */
  void send(VvmAccount account, String number, int port, String text);
 }
 /** Opens an IMAP session over the network the carrier requires. */
 interface Transport { ImapClient connect(VvmAccount account, VvmAccount.Credentials credentials, CarrierVvm carrier) throws IOException; }
 /** No usable network: none at all, or no cellular data when the carrier requires it. */
 static final class Unreachable extends IOException {
  private static final long serialVersionUID = 1L;
  final boolean cellularRequired;
  Unreachable(boolean cellularRequired) { super("No network for voicemail"); this.cellularRequired = cellularRequired; }
 }
 /** One serial worker with a bounded backlog. Both answer false when the work was not accepted. */
 interface Scheduler { boolean run(Runnable work); boolean later(long delayMillis, Runnable work); }

 private final Context context; private final VvmConfiguration config; private final Radio radio; private final Transport transport; private final Scheduler scheduler;
 private VvmSecrets secrets;
 /** Syncs waiting or retrying, as {@code slot:row}; a second request for the same thing is dropped. */
 private final Set<String> syncing = new HashSet<>();
 /** Accounts already asked for a fresh STATUS since their last usable one, so a SYNC notice or a refused login asks once. */
 private final Set<String> statusRequested = new HashSet<>();

 VvmController(Context context, VvmConfiguration config, Radio radio, Transport transport, Scheduler scheduler) {
  this.context = context.getApplicationContext(); this.config = config; this.radio = radio; this.transport = transport; this.scheduler = scheduler;
 }

 private static volatile VvmController instance;
 /** The process's controller over the real platform. */
 public static VvmController get(Context context, VvmConfiguration config) {
  VvmController current = instance;
  if (current == null) synchronized (VvmController.class) {
   if ((current = instance) == null) {
    Context app = context.getApplicationContext();
    instance = current = new VvmController(app, config, new VvmPlatform.SystemRadio(app, config), new VvmPlatform.NetworkTransport(app), new VvmPlatform.Worker());
   }
  }
  return current;
 }

 // ---- Entry points --------------------------------------------------------------------------

 /** The SIM has service: unsupported carriers are marked so; others get the SMS filter and an activation, or a sync when already activated. */
 public void cellServiceConnected(PhoneAccountHandle handle, Runnable done) {
  submit(done, () -> {
   if (handle == null) return;
   VvmAccount account = new VvmAccount(handle);
   CarrierVvm carrier = CarrierVvm.from(radio.carrierConfig(handle));
   if (carrier == null) { unsupported(account); return; }
   if (!radio.filter(handle, carrier.clientPrefix)) { status(account, carrier.type, Status.CONFIGURATION_STATE_FAILED, null, Status.NOTIFICATION_CHANNEL_STATE_NO_CONNECTION, null); return; }
   if (load(account) != null) { sync(account, -1, 0); return; }
   status(account, carrier.type, Status.CONFIGURATION_STATE_CONFIGURING, null, Status.NOTIFICATION_CHANNEL_STATE_OK, null);
   request(account, carrier, "Activate");
  });
 }

 /**
  * A visual-voicemail SMS the platform filtered. {@code fields} are the platform's parsed fields;
  * when it parsed none, {@code body} is read with the carrier's client prefix. STATUS stores or drops
  * the IMAP account and reports the service state; SYNC starts a sync.
  */
 public void smsReceived(PhoneAccountHandle handle, String kind, Map<String, String> fields, String body, Runnable done) {
  submit(done, () -> {
   if (handle == null) return;
   VvmAccount account = new VvmAccount(handle);
   CarrierVvm carrier = CarrierVvm.from(radio.carrierConfig(handle));
   if (carrier == null) { unsupported(account); return; }
   OmtpSms.Message message;
   try {
    message = fields != null && kind != null ? new OmtpSms.Message(kind, fields) : OmtpSms.parse(body, carrier.clientPrefix);
    if (message == null) return; // not an OMTP message (a carrier's legacy text): nothing to act on
    if (OmtpSms.STATUS.equals(message.kind)) statusReceived(account, carrier, OmtpSms.status(message));
    else { OmtpSms.sync(message); notified(account, carrier); }
   } catch (OmtpSms.Malformed malformed) { Log.w(TAG, "Ignored a malformed voicemail SMS: " + malformed.getMessage()); }
  });
 }

 /** The SIM is gone: its filter, rows, status and IMAP account are removed. */
 public void simRemoved(PhoneAccountHandle handle, Runnable done) {
  submit(done, () -> {
   if (handle == null) return;
   VvmAccount account = new VvmAccount(handle);
   radio.filter(handle, null);
   forget(account);
   VvmProvider.forget(context, account);
  });
 }

 /** The platform stopped the service (the host is no longer the visual-voicemail client): everything is removed. */
 public void stopped(Runnable done) {
  if (!accept(done, this::forgetEverything)) done.run();
 }

 /** The owner asked for one row's audio ({@code ACTION_FETCH_VOICEMAIL}). */
 public void fetchRequested(long row, Runnable done) {
  submit(done, () -> {
   VvmAccount account = row > 0 ? VvmProvider.accountOf(context, row) : null;
   if (account != null) sync(account, row, 0);
  });
 }

 /** A sync of every configured account was asked for ({@code ACTION_SYNC_VOICEMAIL}), for example after the owner heard or deleted a voicemail. */
 public void syncRequested(Runnable done) {
  submit(done, () -> { for (VvmAccount account : VvmProvider.configured(context)) sync(account, -1, 0); });
 }

 /** The radio could not send an activation or status request. Only an account still waiting for its answer is marked failed. */
 public void requestNotSent(String component, String id, Runnable done) {
  submit(done, () -> {
   VvmAccount account = new VvmAccount(component, id);
   if (load(account) == null) status(account, null, Status.CONFIGURATION_STATE_FAILED, null, Status.NOTIFICATION_CHANNEL_STATE_NO_CONNECTION, null);
  });
 }

 // ---- Work ----------------------------------------------------------------------------------

 /** Runs work on the worker after the dialer check; {@code done} runs once on every path. */
 private void submit(Runnable done, Runnable work) {
  if (!accept(done, () -> { if (radio.defaultDialer()) work.run(); else forgetEverything(); })) done.run();
 }
 private boolean accept(Runnable done, Runnable work) {
  return scheduler.run(() -> {
   try { work.run(); }
   catch (RuntimeException failed) { Log.w(TAG, "Voicemail work failed: " + failed.getClass().getSimpleName()); }
   finally { done.run(); }
  });
 }

 private void unsupported(VvmAccount account) {
  if (account.handle != null) radio.filter(account.handle, null);
  forget(account);
  VvmProvider.deleteVoicemails(context, account);
  status(account, null, Status.CONFIGURATION_STATE_DISABLED, null, null, null);
 }

 private void statusReceived(VvmAccount account, CarrierVvm carrier, OmtpSms.Status answer) {
  OmtpSms.Channels channels = OmtpSms.channels(answer);
  if (!answer.ready()) {
   // A system error says nothing about the subscriber; anything else means the stored account is no longer good,
   // and rows that can no longer be synced are not kept.
   if (answer.returnCode != 1) { forget(account); VvmProvider.deleteVoicemails(context, account); }
   status(account, carrier.type, channels.configuration, channels.data, channels.notification, null);
   return;
  }
  VvmAccount.Credentials known = load(account);
  boolean same = known != null && known.server.equals(answer.server) && known.user.equals(answer.user);
  if (!save(account, new VvmAccount.Credentials(answer.server, answer.imapPort, answer.user, answer.password, same ? known.uidValidity : -1))) {
   status(account, carrier.type, Status.CONFIGURATION_STATE_FAILED, null, channels.notification, null);
   return;
  }
  // A different mailbox: rows of the old one name nothing in the new one.
  if (known != null && !same) VvmProvider.deleteVoicemails(context, account);
  statusRequested.remove(account.slot);
  status(account, carrier.type, channels.configuration, channels.data, channels.notification, null);
  sync(account, -1, 0);
 }

 private void notified(VvmAccount account, CarrierVvm carrier) {
  if (load(account) != null) sync(account, -1, 0);
  else if (statusRequested.add(account.slot)) request(account, carrier, "STATUS");
 }

 private void request(VvmAccount account, CarrierVvm carrier, String verb) {
  try {
   radio.send(account, carrier.destination, carrier.port, OmtpSms.request(verb, carrier.cvvm(), config.protocolVersion, config.clientType, carrier.port, carrier.clientPrefix));
  } catch (RuntimeException refused) {
   Log.w(TAG, "Voicemail request not sent: " + refused.getClass().getSimpleName());
   status(account, carrier.type, Status.CONFIGURATION_STATE_FAILED, null, Status.NOTIFICATION_CHANNEL_STATE_NO_CONNECTION, null);
  }
 }

 /** One sync attempt on the worker; a passing failure schedules the next attempt until {@link #RETRY_DELAYS} is used up. */
 private void sync(VvmAccount account, long fetchRow, int attempt) {
  String key = account.slot + ":" + fetchRow;
  if (attempt == 0 && !syncing.add(key)) return;
  boolean retry = false;
  ImapClient imap = null;
  try {
   VvmAccount.Credentials credentials = load(account);
   CarrierVvm carrier = account.handle == null ? null : CarrierVvm.from(radio.carrierConfig(account.handle));
   if (credentials == null || carrier == null) return;
   try {
    imap = transport.connect(account, credentials, carrier);
    VvmSync.Result result = VvmSync.run(context, account, credentials, carrier, imap, fetchRow);
    if (result.uidValidity != credentials.uidValidity) save(account, credentials.withUidValidity(result.uidValidity));
    status(account, carrier.type, null, Status.DATA_CHANNEL_STATE_OK, null, result.quota);
   } catch (IOException failed) {
    int state; boolean passing;
    if (failed instanceof Unreachable) {
     state = ((Unreachable) failed).cellularRequired ? Status.DATA_CHANNEL_STATE_NO_CONNECTION_CELLULAR_REQUIRED : Status.DATA_CHANNEL_STATE_NO_CONNECTION; passing = true;
    } else if (failed instanceof ImapClient.ImapException) {
     switch (((ImapClient.ImapException) failed).failure) {
      case AUTHENTICATION:
       state = Status.DATA_CHANNEL_STATE_BAD_CONFIGURATION; passing = false;
       // The carrier may have issued a new password: ask once for a fresh STATUS.
       if (statusRequested.add(account.slot)) request(account, carrier, "STATUS");
       break;
      case PROTOCOL: case TIMEOUT: state = Status.DATA_CHANNEL_STATE_COMMUNICATION_ERROR; passing = true; break;
      case CONSUMER: state = Status.DATA_CHANNEL_STATE_OK; passing = false; break; // the phone could not store audio; the mailbox itself answered
      default: state = Status.DATA_CHANNEL_STATE_SERVER_ERROR; passing = false;
     }
    } else { state = Status.DATA_CHANNEL_STATE_SERVER_CONNECTION_ERROR; passing = true; }
    Log.w(TAG, "Voicemail sync failed: " + (failed instanceof ImapClient.ImapException ? ((ImapClient.ImapException) failed).failure.name() : failed.getClass().getSimpleName()));
    status(account, carrier.type, null, state, null, null);
    retry = passing && attempt < RETRY_DELAYS.length;
   }
  } finally {
   if (imap != null) imap.close();
   final int next = attempt + 1;
   if (!retry || !scheduler.later(RETRY_DELAYS[attempt], () -> {
    try { if (radio.defaultDialer()) sync(account, fetchRow, next); else { syncing.remove(key); forgetEverything(); } }
    catch (RuntimeException failed) { syncing.remove(key); Log.w(TAG, "Voicemail retry failed: " + failed.getClass().getSimpleName()); }
   })) syncing.remove(key);
  }
 }

 // ---- State ---------------------------------------------------------------------------------

 private void status(VvmAccount account, String type, Integer configuration, Integer data, Integer notification, long[] quota) {
  try { VvmProvider.status(context, account, type, configuration, data, notification, quota); }
  catch (RuntimeException refused) { Log.w(TAG, "Voicemail status not written: " + refused.getClass().getSimpleName()); }
 }
 private VvmSecrets secrets() throws Exception { if (secrets == null) secrets = config.secrets.open(context); return secrets; }
 private VvmAccount.Credentials load(VvmAccount account) {
  try { String stored = secrets().read(account.slot); return stored == null ? null : VvmAccount.Credentials.decode(stored); }
  catch (Exception unreadable) { Log.w(TAG, "Voicemail account unreadable: " + unreadable.getClass().getSimpleName()); return null; }
 }
 private boolean save(VvmAccount account, VvmAccount.Credentials credentials) {
  try { secrets().write(account.slot, credentials.encode()); return true; }
  catch (Exception failed) { Log.w(TAG, "Voicemail account not stored: " + failed.getClass().getSimpleName()); return false; }
 }
 private void forget(VvmAccount account) {
  statusRequested.remove(account.slot);
  try { secrets().clear(account.slot); }
  catch (Exception failed) { Log.w(TAG, "Voicemail account not cleared: " + failed.getClass().getSimpleName()); }
 }
 /** Removes every IMAP account, row and status this source holds, and clears the default subscription's filter. */
 private void forgetEverything() {
  statusRequested.clear();
  try { secrets().clearAll(); }
  catch (Exception failed) { Log.w(TAG, "Voicemail accounts not cleared: " + failed.getClass().getSimpleName()); }
  radio.filter(null, null);
  try { VvmProvider.forgetAll(context); }
  catch (RuntimeException refused) { Log.w(TAG, "Voicemail rows not removed: " + refused.getClass().getSimpleName()); }
 }
}
