package ai.eliza.plugins.messages.vvm;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.CancellationSignal;
import android.os.PersistableBundle;
import android.provider.VoicemailContract;
import android.telecom.PhoneAccountHandle;

import ai.eliza.plugins.messages.VoicemailStore;
import java.io.IOException;
import java.net.Socket;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

/**
 * The client's decisions with a fake radio, an in-memory account store, an inline worker, a fake
 * voicemail provider and the in-process IMAP server: activation, STATUS and SYNC handling, what the
 * existing reader ({@link VoicemailStore}) then sees, retries, and everything that must be removed.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, manifest = Config.NONE)
public final class VvmControllerTest {
 static void require(boolean yes, String what) { if (!yes) throw new AssertionError(what); }
 public static final class Receiver extends VisualVoicemailReceiver {
  @Override protected VvmConfiguration configuration() { throw new AssertionError("not delivered in these tests"); }
 }

 static final class Secrets implements VvmSecrets {
  final Map<String, String> slots = new HashMap<>();
  boolean broken;
  @Override public String read(String slot) throws Exception { if (broken) throw new IOException("locked"); return slots.get(slot); }
  @Override public void write(String slot, String value) throws Exception { if (broken) throw new IOException("locked"); slots.put(slot, value); }
  @Override public void clear(String slot) { slots.remove(slot); }
  @Override public void clearAll() { slots.clear(); }
 }
 final class Radio implements VvmController.Radio {
  boolean dialer = true, filterWorks = true, sendWorks = true;
  PersistableBundle config = VvmSyncTest.carrierConfig(CarrierVvm.OMTP, true);
  final Map<String, String> filters = new HashMap<>();
  final List<String> sent = new ArrayList<>();
  @Override public boolean defaultDialer() { return dialer; }
  @Override public PersistableBundle carrierConfig(PhoneAccountHandle handle) { return config; }
  @Override public boolean filter(PhoneAccountHandle handle, String clientPrefix) {
   if (!filterWorks) return false;
   String key = handle == null ? "default" : handle.getId();
   if (clientPrefix == null) filters.remove(key); else filters.put(key, clientPrefix);
   return true;
  }
  @Override public void send(VvmAccount account, String number, int port, String text) {
   if (!sendWorks) throw new IllegalStateException("radio off");
   sent.add(number + ":" + port + ":" + text);
  }
 }
 final class Inline implements VvmController.Scheduler {
  boolean full;
  final List<Long> delays = new ArrayList<>();
  @Override public boolean run(Runnable work) { if (full) return false; work.run(); return true; }
  @Override public boolean later(long delayMillis, Runnable work) { delays.add(delayMillis); work.run(); return true; }
 }

 final Context context = RuntimeEnvironment.getApplication();
 final PhoneAccountHandle handle = new PhoneAccountHandle(VvmSyncTest.PHONE, "1");
 final VvmAccount account = new VvmAccount(handle);
 final Secrets secrets = new Secrets();
 final Radio radio = new Radio();
 final Inline worker = new Inline();
 FakeImapServer server;
 int connects, finished;
 IOException unreachable;
 VvmController controller;
 final Runnable done = () -> finished++;

 @Before public void start() throws IOException {
  FakeVoicemailProvider.install();
  server = new FakeImapServer();
  VvmController.Transport transport = (account, credentials, carrier) -> {
   connects++;
   if (unreachable != null) throw unreachable;
   return new ImapClient(new Socket(credentials.server, credentials.port), 2_000, 20_000, null);
  };
  controller = new VvmController(context, new VvmConfiguration(Receiver.class).withSecrets(context -> secrets), radio, transport, worker);
 }
 @After public void stop() throws IOException { server.close(); }

 Map<String, String> ready() {
  Map<String, String> fields = new HashMap<>();
  fields.put("st", "R"); fields.put("rc", "0"); fields.put("srv", "127.0.0.1"); fields.put("imap", String.valueOf(server.port())); fields.put("u", "user"); fields.put("pw", "secret");
  return fields;
 }
 Map<String, Object> status() {
  for (Map<String, Object> row : FakeVoicemailProvider.table("status")) if ("1".equals(row.get("phone_account_id"))) return row;
  return null;
 }
 boolean status(int configuration, Integer data, Integer notification) {
  Map<String, Object> row = status();
  return row != null && Integer.valueOf(configuration).equals(row.get("configuration_state")) && (data == null || data.equals(row.get("data_channel_state")))
    && (notification == null || notification.equals(row.get("notification_channel_state")));
 }
 String readerState() { return VoicemailStore.carrierState(context, account.component, account.id, new CancellationSignal()); }
 JSONArray readerList() throws Exception { return VoicemailStore.list(context, 50, account.component, account.id, false, new CancellationSignal()).getJSONArray("voicemails"); }
 void activate() { controller.cellServiceConnected(handle, done); controller.smsReceived(handle, "STATUS", ready(), null, done); }

 @Test public void aCarrierWithoutASupportedTypeIsReportedUnsupported() {
  for (PersistableBundle config : new PersistableBundle[] { null, new PersistableBundle(), VvmSyncTest.carrierConfig("vvm_type_vvm3", true), legacy() }) {
   FakeVoicemailProvider.install(); radio.filters.put("1", "//OLD"); secrets.slots.put(account.slot, "{}"); finished = 0;
   radio.config = config;
   controller.cellServiceConnected(handle, done);
   require(finished == 1, "the task is finished");
   require(status(VoicemailContract.Status.CONFIGURATION_STATE_DISABLED, null, null) && FakeVoicemailProvider.table("status").size() == 1, "one status row saying disabled");
   require(readerState().equals(VoicemailStore.UNSUPPORTED), "which the reader shows as unsupported");
   require(radio.filters.isEmpty() && radio.sent.isEmpty() && secrets.slots.isEmpty() && connects == 0, "no filter, no SMS, no account, no connection");
  }
 }
 static PersistableBundle legacy() {
  PersistableBundle config = VvmSyncTest.carrierConfig(CarrierVvm.OMTP, true);
  config.putBoolean(android.telephony.CarrierConfigManager.KEY_VVM_LEGACY_MODE_ENABLED_BOOL, true);
  return config;
 }

 @Test public void serviceSetsTheFilterAndAsksTheCarrierToActivate() {
  controller.cellServiceConnected(handle, done);
  require(finished == 1 && "//VVM".equals(radio.filters.get("1")), "filter set with the default client prefix");
  require(radio.sent.equals(java.util.Collections.singletonList("127:5499:Activate")), "OMTP 1.1 activation to the carrier's number and port");
  require(status(VoicemailContract.Status.CONFIGURATION_STATE_CONFIGURING, null, VoicemailContract.Status.NOTIFICATION_CHANNEL_STATE_OK), "configuring");
  require(readerState().equals(VoicemailStore.UNCONFIGURED) && connects == 0, "not ready until the carrier answers");
  require("vvm_type_omtp".equals(status().get("source_type")) && context.getPackageName().equals(status().get("source_package")), "this source's row");
 }

 @Test public void theCvvmVariantAndACarrierPrefixChangeOnlyTheTexts() {
  radio.config = VvmSyncTest.carrierConfig(CarrierVvm.CVVM, true);
  radio.config.putString(android.telephony.CarrierConfigManager.KEY_VVM_CLIENT_PREFIX_STRING, "//CVVM");
  controller.cellServiceConnected(handle, done);
  require("//CVVM".equals(radio.filters.get("1")) && radio.sent.get(0).equals("127:5499:Activate:dt=6"), "CVVM request and prefix");
  controller.smsReceived(handle, null, null, "//CVVM:STATUS:st=R;rc=0;srv=127.0.0.1;imap=" + server.port() + ";u=user;pw=secret", done);
  require(finished == 2 && secrets.slots.containsKey(account.slot) && readerState().equals(VoicemailStore.READY), "a STATUS the platform did not parse is read from its body");
 }

 @Test public void aReadyStatusStoresTheAccountAndSyncsIntoTheReader() throws Exception {
  server.add(1, "\\Seen"); server.add(2);
  activate();
  require(finished == 2, "both tasks finished");
  VvmAccount.Credentials stored = VvmAccount.Credentials.decode(secrets.slots.get(account.slot));
  require(stored.server.equals("127.0.0.1") && stored.user.equals("user") && stored.password.equals("secret") && stored.uidValidity == 7, "the account, and the generation synced");
  require(status(VoicemailContract.Status.CONFIGURATION_STATE_OK, VoicemailContract.Status.DATA_CHANNEL_STATE_OK, VoicemailContract.Status.NOTIFICATION_CHANNEL_STATE_OK), "all channels working");
  require(Integer.valueOf(10).equals(status().get("quota_occupied")) && Integer.valueOf(512).equals(status().get("quota_total")), "the server's quota");
  require(readerState().equals(VoicemailStore.READY), "the reader's reduction says ready");
  JSONArray list = readerList();
  require(list.length() == 2 && list.getJSONObject(0).getBoolean("hasAudio") && list.getJSONObject(0).getString("number").equals("+15555550100"), "the unchanged reader lists them");
  String id = null;
  for (int i = 0; i < list.length(); i++) if (list.getJSONObject(i).getBoolean("isNew")) id = list.getJSONObject(i).getString("id");
  require(id != null && VoicemailStore.audio(context, Long.parseLong(id), new CancellationSignal()).getInt("size") == server.message(2).audio.length, "and returns the audio");

  // Hearing and deleting through the reader mark the rows for this source and ask it to sync.
  Shadows.shadowOf(RuntimeEnvironment.getApplication()).clearBroadcastIntents();
  require(VoicemailStore.markHeard(context, Long.parseLong(id)), "heard");
  List<Intent> asked = Shadows.shadowOf(RuntimeEnvironment.getApplication()).getBroadcastIntents();
  require(asked.size() == 1 && VoicemailContract.ACTION_SYNC_VOICEMAIL.equals(asked.get(0).getAction()) && context.getPackageName().equals(asked.get(0).getPackage()), "a sync asked of this app only");
  controller.syncRequested(done);
  require(server.message(2).flags.contains("\\Seen"), "heard on the server");
  long other = (Long) FakeVoicemailProvider.byUid(context.getPackageName(), 1).get("_id");
  require(VoicemailStore.delete(context, other) && readerList().length() == 1 && server.message(1) != null, "deleted from the list at once, not yet from the server");
  require(!VoicemailStore.delete(context, other), "and only once");
  controller.syncRequested(done);
  require(server.message(1) == null && FakeVoicemailProvider.voicemail(other) == null, "then from the server and the phone");
 }

 @Test public void aSyncNoticeSyncsOrAsksForTheAccountOnce() {
  Map<String, String> notice = new HashMap<>();
  notice.put("ev", "NM"); notice.put("id", "3"); notice.put("c", "1"); notice.put("t", "v"); notice.put("s", "5555550100"); notice.put("dt", "02/08/2008 12:53 +0200"); notice.put("l", "30");
  controller.smsReceived(handle, "SYNC", notice, null, done);
  controller.smsReceived(handle, "SYNC", notice, null, done);
  require(radio.sent.equals(java.util.Collections.singletonList("127:5499:STATUS")) && connects == 0, "without an account: one STATUS request, no connection");
  controller.smsReceived(handle, "STATUS", ready(), null, done);
  server.add(3);
  int before = connects;
  controller.smsReceived(handle, "SYNC", notice, null, done);
  require(connects == before + 1 && FakeVoicemailProvider.byUid(context.getPackageName(), 3) != null && finished == 4, "with one: a sync that brings the new message");
 }

 @Test public void malformedAndForeignMessagesChangeNothing() {
  controller.cellServiceConnected(handle, done);
  Map<String, String> bad = ready(); bad.put("imap", "notaport");
  Map<String, String> incomplete = ready(); incomplete.remove("pw");
  controller.smsReceived(handle, "STATUS", bad, null, done);
  controller.smsReceived(handle, "STATUS", incomplete, null, done);
  controller.smsReceived(handle, "SYNC", new HashMap<>(), null, done);
  controller.smsReceived(handle, "OTHER", ready(), null, done);
  controller.smsReceived(handle, null, null, "You have a new voicemail", done);
  controller.smsReceived(handle, null, null, "//VVM:STATUS:st=R;rc=0", done);
  controller.smsReceived(handle, null, null, null, done);
  controller.smsReceived(null, "STATUS", ready(), null, done);
  require(finished == 9, "every task finished");
  require(secrets.slots.isEmpty() && connects == 0 && radio.sent.size() == 1, "no account stored, nothing contacted");
  require(status(VoicemailContract.Status.CONFIGURATION_STATE_CONFIGURING, null, null), "still waiting for a real answer");
 }

 @Test public void anAnswerThatIsNotReadyDropsTheAccount() {
  server.add(1);
  activate();
  Map<String, String> blocked = new HashMap<>(); blocked.put("st", "B"); blocked.put("rc", "0");
  controller.smsReceived(handle, "STATUS", blocked, null, done);
  require(secrets.slots.isEmpty() && FakeVoicemailProvider.table("voicemail").isEmpty(), "account and rows gone");
  require(status(VoicemailContract.Status.CONFIGURATION_STATE_FAILED, null, null) && readerState().equals(VoicemailStore.UNCONFIGURED), "reported as not working");

  activate();
  Map<String, String> outage = new HashMap<>(); outage.put("st", "R"); outage.put("rc", "1");
  controller.smsReceived(handle, "STATUS", outage, null, done);
  require(secrets.slots.containsKey(account.slot) && FakeVoicemailProvider.table("voicemail").size() == 1, "a carrier system error keeps the account and rows");
  require(status(VoicemailContract.Status.CONFIGURATION_STATE_FAILED, VoicemailContract.Status.DATA_CHANNEL_STATE_SERVER_ERROR, null), "and is not reported as ready");
 }

 @Test public void simRemovalClearsTheAccountRowsStatusAndFilter() {
  server.add(1);
  activate();
  PhoneAccountHandle second = new PhoneAccountHandle(VvmSyncTest.PHONE, "2");
  controller.smsReceived(second, "STATUS", ready(), null, done);
  require(secrets.slots.size() == 2 && FakeVoicemailProvider.table("voicemail").size() == 2 && FakeVoicemailProvider.table("status").size() == 2, "two SIMs configured");
  finished = 0;
  controller.simRemoved(handle, done);
  require(finished == 1, "task finished");
  require(!secrets.slots.containsKey(account.slot) && secrets.slots.containsKey(new VvmAccount(second).slot), "the removed SIM's password is gone; the other SIM's stays");
  require(status() == null && FakeVoicemailProvider.table("status").size() == 1, "its status row is gone");
  require(FakeVoicemailProvider.table("voicemail").size() == 1 && "2".equals(FakeVoicemailProvider.table("voicemail").get(0).get("subscription_id")), "and its rows");
  require(!radio.filters.containsKey("1") && readerState().equals(VoicemailStore.UNSUPPORTED), "filter cleared; the reader sees no source");
  int before = connects;
  controller.syncRequested(done);
  controller.fetchRequested(1, done);
  require(server.sessions == connects && connects == before + 1, "later syncs touch only the remaining SIM");
 }

 @Test public void stoppingOrLosingTheDialerRoleRemovesEverything() {
  server.add(1);
  activate();
  finished = 0;
  controller.stopped(done);
  require(finished == 1 && secrets.slots.isEmpty() && FakeVoicemailProvider.table("voicemail").isEmpty() && FakeVoicemailProvider.table("status").isEmpty(), "stopped: nothing left");

  activate();
  require(!secrets.slots.isEmpty(), "configured again");
  radio.dialer = false;
  int before = connects; finished = 0;
  controller.syncRequested(done);
  require(finished == 1 && connects == before && secrets.slots.isEmpty() && FakeVoicemailProvider.table("voicemail").isEmpty() && FakeVoicemailProvider.table("status").isEmpty(),
    "no longer the dialer: the next entry removes everything instead of working");
  controller.cellServiceConnected(handle, done);
  controller.smsReceived(handle, "STATUS", ready(), null, done);
  require(finished == 3 && secrets.slots.isEmpty() && radio.sent.size() == 2 && connects == before, "and nothing is activated or stored while it is not");
 }

 @Test public void aPassingFailureIsRetriedABoundedNumberOfTimes() {
  unreachable = new IOException("connect failed");
  activate();
  require(connects == 1 + VvmController.RETRY_DELAYS.length, "one attempt and three retries, then it stops");
  List<Long> expected = new ArrayList<>();
  for (long delay : VvmController.RETRY_DELAYS) expected.add(delay);
  require(worker.delays.equals(expected), "with growing waits");
  require(status(VoicemailContract.Status.CONFIGURATION_STATE_OK, VoicemailContract.Status.DATA_CHANNEL_STATE_SERVER_CONNECTION_ERROR, null), "the data channel says why");
  require(finished == 2, "tasks finished");

  unreachable = new VvmController.Unreachable(true);
  controller.syncRequested(done);
  require(status(VoicemailContract.Status.CONFIGURATION_STATE_OK, VoicemailContract.Status.DATA_CHANNEL_STATE_NO_CONNECTION_CELLULAR_REQUIRED, null), "no cellular data when the carrier requires it");
  unreachable = null;
  int before = connects;
  controller.syncRequested(done);
  require(connects == before + 1 && status(VoicemailContract.Status.CONFIGURATION_STATE_OK, VoicemailContract.Status.DATA_CHANNEL_STATE_OK, null), "a later sync recovers and is not retried");
 }

 @Test public void aRefusedLoginIsNotRetriedAndAsksForAFreshStatusOnce() {
  server.password = "rotated";
  activate();
  require(connects == 1 && worker.delays.isEmpty(), "no retry with a password the server refuses");
  require(status(VoicemailContract.Status.CONFIGURATION_STATE_OK, VoicemailContract.Status.DATA_CHANNEL_STATE_BAD_CONFIGURATION, null), "bad configuration");
  require(radio.sent.equals(java.util.Arrays.asList("127:5499:Activate", "127:5499:STATUS")), "one STATUS request for a new account");
  controller.syncRequested(done);
  require(radio.sent.size() == 2, "not asked again");
  Map<String, String> renewed = ready(); renewed.put("pw", "rotated");
  server.add(1);
  controller.smsReceived(handle, "STATUS", renewed, null, done);
  require(FakeVoicemailProvider.table("voicemail").size() == 1 && status(VoicemailContract.Status.CONFIGURATION_STATE_OK, VoicemailContract.Status.DATA_CHANNEL_STATE_OK, null), "the renewed account syncs");
 }

 @Test public void aServerThatBreaksABoundIsNotRetried() {
  server.overrides.put("UID SEARCH", "* SEARCH {99999999}\r\n");
  activate();
  require(connects == 1 && worker.delays.isEmpty() && status(VoicemailContract.Status.CONFIGURATION_STATE_OK, VoicemailContract.Status.DATA_CHANNEL_STATE_SERVER_ERROR, null), "server error, once");
 }

 @Test public void failuresOfThePlatformStillFinishEveryTask() {
  radio.filterWorks = false;
  controller.cellServiceConnected(handle, done);
  require(finished == 1 && radio.sent.isEmpty() && status(VoicemailContract.Status.CONFIGURATION_STATE_FAILED, null, VoicemailContract.Status.NOTIFICATION_CHANNEL_STATE_NO_CONNECTION), "a refused filter");
  radio.filterWorks = true; radio.sendWorks = false;
  controller.cellServiceConnected(handle, done);
  require(finished == 2 && status(VoicemailContract.Status.CONFIGURATION_STATE_FAILED, null, VoicemailContract.Status.NOTIFICATION_CHANNEL_STATE_NO_CONNECTION), "a refused SMS");
  radio.sendWorks = true;
  controller.cellServiceConnected(handle, done);
  controller.requestNotSent(account.component, account.id, done);
  require(finished == 4 && status(VoicemailContract.Status.CONFIGURATION_STATE_FAILED, null, VoicemailContract.Status.NOTIFICATION_CHANNEL_STATE_NO_CONNECTION), "an SMS the radio reported unsent");
  secrets.broken = true;
  controller.smsReceived(handle, "STATUS", ready(), null, done);
  require(finished == 5 && connects == 0 && status(VoicemailContract.Status.CONFIGURATION_STATE_FAILED, null, null), "an account that cannot be stored is not used");
  secrets.broken = false;
  worker.full = true;
  controller.cellServiceConnected(handle, done); controller.smsReceived(handle, "STATUS", ready(), null, done); controller.simRemoved(handle, done); controller.stopped(done);
  controller.fetchRequested(1, done); controller.syncRequested(done);
  require(finished == 11 && secrets.slots.isEmpty(), "work the worker refused is finished, not done");
 }
}
