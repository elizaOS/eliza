package ai.eliza.plugins.messages.vvm;

import android.content.ComponentName;
import android.content.ContentValues;
import android.content.Context;
import android.os.PersistableBundle;
import android.telecom.PhoneAccountHandle;
import android.telephony.CarrierConfigManager;

import java.io.IOException;
import java.util.Arrays;
import java.util.Map;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/** The reconcile between an in-process IMAP server and a fake voicemail provider, through the real IMAP client. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, manifest = Config.NONE)
public final class VvmSyncTest {
 static void require(boolean yes, String what) { if (!yes) throw new AssertionError(what); }
 static final ComponentName PHONE = new ComponentName("com.android.phone", "com.android.services.telephony.TelephonyConnectionService");

 final Context context = RuntimeEnvironment.getApplication();
 final VvmAccount account = new VvmAccount(new PhoneAccountHandle(PHONE, "1"));
 FakeImapServer server;
 VvmAccount.Credentials credentials;

 @Before public void start() throws IOException {
  FakeVoicemailProvider.install();
  server = new FakeImapServer();
  credentials = new VvmAccount.Credentials("127.0.0.1", server.port(), "user", "secret", -1);
 }
 @After public void stop() throws IOException { server.close(); }

 static PersistableBundle carrierConfig(String type, boolean prefetch) {
  PersistableBundle config = new PersistableBundle();
  config.putString(CarrierConfigManager.KEY_VVM_TYPE_STRING, type);
  config.putString(CarrierConfigManager.KEY_VVM_DESTINATION_NUMBER_STRING, "127");
  config.putInt(CarrierConfigManager.KEY_VVM_PORT_NUMBER_INT, 5499);
  config.putBoolean(CarrierConfigManager.KEY_VVM_PREFETCH_BOOL, prefetch);
  return config;
 }
 VvmSync.Result sync(boolean prefetch, long fetchRow) throws IOException {
  ImapClient imap = new ImapClient(server.connect(), 2_000, 20_000, null);
  try { return VvmSync.run(context, account, credentials, CarrierVvm.from(carrierConfig(CarrierVvm.OMTP, prefetch)), imap, fetchRow); }
  finally { imap.close(); }
 }
 Map<String, Object> row(long uid) { return FakeVoicemailProvider.byUid(context.getPackageName(), uid); }
 long id(long uid) { return (Long) row(uid).get("_id"); }
 void local(long id, Object... pairs) {
  ContentValues values = new ContentValues();
  for (int i = 0; i < pairs.length; i += 2) values.put((String) pairs[i], (Integer) pairs[i + 1]);
  require(context.getContentResolver().update(VvmProvider.voicemail(context, id), values, null, null) == 1, "local row changed");
 }

 @Test public void newMessagesBecomeRowsWithTheirAudio() throws Exception {
  server.add(3, "\\Seen");
  FakeImapServer.Message second = server.add(8);
  second.from = "5555550123"; second.duration = 41; second.textFirst = true; second.subtype = "3gpp"; second.audio = new byte[70_000];
  new java.util.Random(1).nextBytes(second.audio);
  server.add(9).voice = false;
  FakeImapServer.Message withheld = server.add(10); withheld.from = "anonymous"; withheld.date = "not a date";

  VvmSync.Result result = sync(true, -1);
  require(result.inserted == 3 && result.downloaded == 3 && result.uidValidity == 7 && Arrays.equals(result.quota, new long[] { 10, 512 }), "three voicemails, the server's generation and quota");
  require(row(9) == null, "a message without an audio part is not a voicemail");
  Map<String, Object> heard = row(3), fresh = row(8);
  require(Integer.valueOf(1).equals(heard.get("is_read")) && Integer.valueOf(0).equals(fresh.get("is_read")), "read state from \\Seen");
  require("+15555550100".equals(heard.get("number")) && "5555550123".equals(fresh.get("number")), "the caller's number");
  require(Long.valueOf(1784256265000L).equals(fresh.get("date")) && Long.valueOf(41).equals(fresh.get("duration")), "date and duration");
  require(context.getPackageName().equals(fresh.get("source_package")) && "8".equals(fresh.get("source_data")), "this source, the IMAP UID");
  require(account.component.equals(fresh.get("subscription_component_name")) && "1".equals(fresh.get("subscription_id")), "the calling account");
  require(Integer.valueOf(1).equals(fresh.get("has_content")) && "audio/3gpp".equals(fresh.get("mime_type")), "audio marked present with its type");
  require(Arrays.equals(FakeVoicemailProvider.audio(context, id(8)), second.audio), "the audio part (section 2), decoded, in the row's stream");
  require("".equals(row(10).get("number")) && Long.valueOf(1784256270000L).equals(row(10).get("date")), "a withheld caller is empty; a bad Date header falls back to INTERNALDATE");
  require(!server.message(8).flags.contains("\\Seen"), "downloading does not mark the message heard on the server");

  int writes = FakeVoicemailProvider.writes;
  VvmSync.Result again = sync(true, -1);
  require(again.inserted == 0 && again.downloaded == 0 && again.removed == 0 && FakeVoicemailProvider.writes == writes, "a second sync changes nothing");
 }

 @Test public void withoutPrefetchAudioComesOnlyWhenAsked() throws Exception {
  server.add(1); server.add(2);
  VvmSync.Result result = sync(false, -1);
  require(result.inserted == 2 && result.downloaded == 0, "rows only");
  require(Integer.valueOf(0).equals(row(1).get("has_content")) && FakeVoicemailProvider.audio(context, id(1)) == null, "no audio yet");
  require(sync(false, id(2)).downloaded == 1, "the requested row");
  require(Integer.valueOf(1).equals(row(2).get("has_content")) && "audio/amr".equals(row(2).get("mime_type")) && Arrays.equals(FakeVoicemailProvider.audio(context, id(2)), server.message(2).audio), "its audio");
  require(Integer.valueOf(0).equals(row(1).get("has_content")), "and no other");
  require(sync(false, id(2)).downloaded == 0 && sync(false, 999).downloaded == 0, "already there; an unknown row asks for nothing");
 }

 @Test public void hearingOnThePhoneIsPushedAndHearingElsewhereIsPulled() throws Exception {
  server.add(1); server.add(2); server.add(3);
  sync(false, -1);
  local(id(1), "is_read", 1, "dirty", 1);
  server.message(2).flags.add("\\Seen");
  sync(false, -1);
  require(server.message(1).flags.contains("\\Seen"), "heard on the phone → \\Seen on the server");
  require(Integer.valueOf(0).equals(row(1).get("dirty")) && Integer.valueOf(1).equals(row(1).get("is_read")), "and the row is settled");
  require(Integer.valueOf(1).equals(row(2).get("is_read")), "heard elsewhere → read on the phone");
  require(!server.message(3).flags.contains("\\Seen") && Integer.valueOf(0).equals(row(3).get("is_read")), "the untouched one stays new on both sides");
  require(server.commands().stream().filter(command -> command.startsWith("UID STORE")).count() == 1, "one store, for the one change");
 }

 @Test public void deletingOnThePhoneIsPushedAndDeletingElsewhereIsPulled() throws Exception {
  server.add(1); server.add(2); server.add(3); server.add(4);
  sync(true, -1);
  long gone = id(2), expunged = id(1);
  local(expunged, "deleted", 1, "dirty", 1);
  server.messages.remove(server.message(2));
  server.message(4).flags.add("\\Deleted");
  VvmSync.Result result = sync(true, -1);
  require(server.message(1) == null && server.sent("UID EXPUNGE 1"), "deleted on the phone → flagged and expunged on the server");
  require(FakeVoicemailProvider.voicemail(expunged) == null && FakeVoicemailProvider.audio(context, expunged) == null, "then removed from the phone with its audio");
  require(FakeVoicemailProvider.voicemail(gone) == null, "deleted elsewhere → removed from the phone");
  require(row(4) == null && server.message(4) != null, "a message another client flagged deleted is gone here and left for that client to expunge");
  require(row(3) != null && server.message(3) != null && result.removed == 3, "the rest stays");

  server.uidPlus = false;
  local(id(3), "deleted", 1, "dirty", 1);
  sync(true, -1);
  require(server.message(3) == null && server.sent("EXPUNGE") && FakeVoicemailProvider.table("voicemail").isEmpty(), "without UIDPLUS a plain EXPUNGE");
 }

 @Test public void aNewMailboxGenerationDropsTheRowsAndPushesNothing() throws Exception {
  server.add(1); server.add(2);
  VvmSync.Result first = sync(false, -1);
  credentials = credentials.withUidValidity(first.uidValidity);
  local(id(1), "deleted", 1, "dirty", 1);
  long old = id(2);
  server.uidValidity = 8;
  VvmSync.Result result = sync(false, -1);
  require(result.uidValidity == 8 && result.removed == 2 && result.inserted == 2, "everything read again");
  require(server.message(1) != null && !server.sent("UID STORE"), "a stale UID deletes nothing on the server");
  require(FakeVoicemailProvider.voicemail(old) == null && row(1) != null && row(2) != null, "fresh rows");
 }

 @Test public void otherSourcesAndOtherAccountsAreLeftAlone() throws Exception {
  ContentValues foreign = new ContentValues();
  foreign.put("source_package", "com.example.other"); foreign.put("source_data", "77"); foreign.put("subscription_component_name", account.component); foreign.put("subscription_id", "1");
  context.getContentResolver().insert(android.provider.VoicemailContract.Voicemails.CONTENT_URI, foreign);
  ContentValues otherSim = new ContentValues();
  otherSim.put("source_package", context.getPackageName()); otherSim.put("source_data", "78"); otherSim.put("subscription_component_name", account.component); otherSim.put("subscription_id", "2");
  context.getContentResolver().insert(android.provider.VoicemailContract.Voicemails.CONTENT_URI, otherSim);
  ContentValues stray = new ContentValues();
  stray.put("source_package", context.getPackageName()); stray.put("source_data", "not-a-uid"); stray.put("subscription_component_name", account.component); stray.put("subscription_id", "1");
  context.getContentResolver().insert(android.provider.VoicemailContract.Voicemails.CONTENT_URI, stray);
  server.add(5);
  sync(true, -1);
  require(FakeVoicemailProvider.byUid("com.example.other", 77) != null, "another source's row");
  require(row(78) != null, "this source's row for another SIM");
  require(FakeVoicemailProvider.table("voicemail").size() == 3 && row(5) != null, "this account's unreadable row is replaced by the mailbox's");
 }

 @Test public void audioThisClientCannotTakeStaysOnTheServer() throws Exception {
  FakeImapServer.Message big = server.add(1);
  big.audio = new byte[VvmSync.MAX_AUDIO_BYTES + 100_000];
  server.add(2);
  VvmSync.Result result = sync(true, -1);
  require(result.inserted == 2 && result.downloaded == 1, "the oversize audio is not requested");
  require(Integer.valueOf(0).equals(row(1).get("has_content")) && Integer.valueOf(1).equals(row(2).get("has_content")), "its row has no audio; the other does");
  require(server.commands().stream().noneMatch(command -> command.startsWith("UID FETCH 1 (UID BODY.PEEK")), "never asked for");
 }

 @Test public void aRefusedLoginChangesNothing() throws Exception {
  server.add(1);
  credentials = new VvmAccount.Credentials("127.0.0.1", server.port(), "user", "old", -1);
  try { sync(true, -1); throw new AssertionError("synced"); }
  catch (ImapClient.ImapException failed) { require(failed.failure == ImapClient.Failure.AUTHENTICATION, "authentication"); }
  require(FakeVoicemailProvider.writes == 0 && !server.sent("SELECT"), "nothing read or written");
 }
}
