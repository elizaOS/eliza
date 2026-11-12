package ai.eliza.plugins.contacts;

import android.content.ContentProvider;
import android.content.ContentProviderOperation;
import android.content.ContentProviderResult;
import android.content.ContentValues;
import android.content.OperationApplicationException;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.provider.ContactsContract;

import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/**
 * ContactsEditor against a fake Contacts provider that raises a raw contact's version on every data
 * change, as Android's does: the version digest, draft validation, type names, and saves and
 * removals that are refused as stale without writing when the contact changed.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, manifest = Config.NONE)
public final class ContactsEditorTest {
  static void require(boolean yes, String what) { if (!yes) throw new AssertionError(what); }

  /** Raw contacts as {contactId, version}; data rows by ID. A raw contact's contact ID is its own ID plus 100. */
  static final Map<Long, long[]> raws = new TreeMap<>();
  static final Map<Long, Map<String, Object>> data = new TreeMap<>();
  static long nextRaw, nextData;
  /** Runs once when the next batch arrives, before any of its operations: another writer getting in first. */
  static Runnable beforeBatch;
  static boolean refuseReadback;
  static boolean loseBatchReply;
  static int writes;

  static long addRaw(long contact) {
    long id = ++nextRaw;
    raws.put(id, new long[] { contact > 0 ? contact : id + 100, 1 });
    return id;
  }
  static long addData(long raw, String mime, String value, Integer type, String label) {
    Map<String, Object> row = new HashMap<>();
    row.put("raw_contact_id", raw); row.put("mimetype", mime); row.put("data1", value); row.put("data2", type); row.put("data3", label);
    data.put(++nextData, row);
    raws.get(raw)[1]++;
    return nextData;
  }
  static final String NAME = ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE, PHONE = ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE,
    EMAIL = ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE;

  public static final class Provider extends ContentProvider {
    @Override public boolean onCreate() { return true; }
    private static String name(long contact) {
      for (Map<String, Object> row : data.values())
        if (NAME.equals(row.get("mimetype")) && raws.containsKey(row.get("raw_contact_id")) && raws.get(row.get("raw_contact_id"))[0] == contact) return (String) row.get("data1");
      return null;
    }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
      List<String> path = uri.getPathSegments();
      if (projection == null) projection = new String[] { "_id" };
      MatrixCursor cursor = new MatrixCursor(projection);
      List<Map<String, Object>> rows = new ArrayList<>();
      if (path.get(0).equals("raw_contacts")) {
        if (refuseReadback && path.size() > 1 && Arrays.equals(projection, new String[] { "contact_id" })) throw new SecurityException("Contacts read access changed");
        for (Map.Entry<Long, long[]> raw : raws.entrySet()) {
          if (path.size() > 1 ? !path.get(1).equals(String.valueOf(raw.getKey())) : !args[0].equals(String.valueOf(raw.getValue()[0]))) continue;
          Map<String, Object> row = new HashMap<>();
          row.put("_id", raw.getKey()); row.put("contact_id", raw.getValue()[0]); row.put("version", raw.getValue()[1]);
          rows.add(row);
        }
      } else if (path.get(0).equals("contacts")) {
        long contact = Long.parseLong(path.get(1));
        boolean exists = false;
        for (long[] raw : raws.values()) exists |= raw[0] == contact;
        if (exists) {
          Map<String, Object> row = new HashMap<>();
          row.put("lookup", "key" + contact); row.put("display_name", name(contact)); row.put("starred", 0);
          rows.add(row);
        }
      } else {
        for (Map.Entry<Long, Map<String, Object>> entry : data.entrySet()) {
          long[] raw = raws.get(entry.getValue().get("raw_contact_id"));
          if (raw == null || !args[0].equals(String.valueOf(raw[0])) || !args[1].equals(entry.getValue().get("mimetype"))) continue;
          Map<String, Object> row = new HashMap<>(entry.getValue());
          row.put("_id", entry.getKey());
          rows.add(row);
        }
      }
      for (Map<String, Object> row : rows) {
        Object[] values = new Object[projection.length];
        for (int i = 0; i < projection.length; i++) values[i] = row.get(projection[i]);
        cursor.addRow(values);
      }
      return cursor;
    }
    @Override public String getType(Uri uri) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) {
      writes++;
      if (uri.getPathSegments().get(0).equals("raw_contacts")) return Uri.withAppendedPath(uri, String.valueOf(addRaw(0)));
      long id = addData(values.getAsLong("raw_contact_id"), values.getAsString("mimetype"), values.getAsString("data1"), values.getAsInteger("data2"), values.getAsString("data3"));
      return Uri.withAppendedPath(uri, String.valueOf(id));
    }
    @Override public int delete(Uri uri, String selection, String[] args) {
      writes++;
      List<String> path = uri.getPathSegments();
      if (path.get(0).equals("contacts")) {
        long contact = Long.parseLong(path.get(1));
        int before = raws.size();
        raws.values().removeIf(raw -> raw[0] == contact);
        return before - raws.size();
      }
      List<Long> gone = new ArrayList<>();
      for (Map.Entry<Long, Map<String, Object>> entry : data.entrySet()) {
        boolean match = path.size() > 1 ? path.get(1).equals(String.valueOf(entry.getKey()))
          : Arrays.asList(args).subList(0, args.length - 1).contains(String.valueOf(entry.getValue().get("raw_contact_id"))) && args[args.length - 1].equals(entry.getValue().get("mimetype"));
        if (match) gone.add(entry.getKey());
      }
      for (long id : gone) { raws.get(data.remove(id).get("raw_contact_id"))[1]++; }
      return gone.size();
    }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public ContentProviderResult[] applyBatch(ArrayList<ContentProviderOperation> operations) throws OperationApplicationException {
      Runnable first = beforeBatch;
      beforeBatch = null;
      if (first != null) first.run();
      ContentProviderResult[] result = super.applyBatch(operations);
      if (loseBatchReply) throw new android.os.DeadObjectException().rethrowAsRuntimeException();
      return result;
    }
  }

  ContactsEditor editor;
  @Before public void provider() {
    raws.clear(); data.clear(); nextRaw = 0; nextData = 0; beforeBatch = null; refuseReadback = false; loseBatchReply = false; writes = 0;
    ProviderInfo info = new ProviderInfo();
    info.authority = ContactsContract.AUTHORITY;
    Robolectric.buildContentProvider(Provider.class).create(info);
    editor = new ContactsEditor(RuntimeEnvironment.getApplication());
  }
  /** The editor refuses the main thread, which is where Robolectric runs tests. */
  static <T> T off(Callable<T> work) throws Exception {
    java.util.concurrent.ExecutorService thread = Executors.newSingleThreadExecutor();
    try { return thread.submit(work).get(); }
    catch (ExecutionException failed) { throw (Exception) failed.getCause(); }
    finally { thread.shutdown(); }
  }
  static JSONArray list(String key, String... valueThenType) throws Exception {
    JSONArray out = new JSONArray();
    for (int i = 0; i < valueThenType.length; i += 2) out.put(new JSONObject().put(key, valueThenType[i]).put("type", valueThenType[i + 1]));
    return out;
  }
  static ContactsEditor.Draft draft(String name, JSONArray phones, JSONArray emails) { return ContactsEditor.draft(name, phones, emails); }
  static void invalid(String what, Callable<?> attempt) throws Exception {
    try { attempt.call(); } catch (IllegalArgumentException expected) { return; }
    throw new AssertionError(what + " refused");
  }
  JSObject get(String id) throws Exception { return off(() -> editor.get(id, new CancellationSignal())); }

  @Test public void theVersionFollowsEveryRawContactAndItsProviderVersion() {
    String one = ContactsEditor.version(Arrays.asList(new long[] { 4, 7 }, new long[] { 9, 2 }));
    require(ContactsEditor.versionShape(one), "64 hex characters");
    require(one.equals(ContactsEditor.version(Arrays.asList(new long[] { 9, 2 }, new long[] { 4, 7 }))), "read order does not matter");
    require(!one.equals(ContactsEditor.version(Arrays.asList(new long[] { 4, 8 }, new long[] { 9, 2 }))), "a data change raises the version");
    require(!one.equals(ContactsEditor.version(Arrays.asList(new long[] { 4, 7 }))), "an unmerged raw contact changes it");
    require(!one.equals(ContactsEditor.version(Arrays.asList(new long[] { 4, 7 }, new long[] { 9, 2 }, new long[] { 11, 1 }))), "a merged raw contact changes it");
    require(!ContactsEditor.version(Arrays.asList(new long[] { 1, 23 })).equals(ContactsEditor.version(Arrays.asList(new long[] { 12, 3 }))), "pairs cannot run together");
    require(!ContactsEditor.versionShape("abc") && !ContactsEditor.versionShape(null) && !ContactsEditor.versionShape(one.toUpperCase(java.util.Locale.ROOT)), "other strings are not versions");
    require(ContactsEditor.row("12") == 12 && ContactsEditor.row("0") == -1 && ContactsEditor.row("1 ") == -1 && ContactsEditor.row(null) == -1, "contact ids");
  }

  @Test public void draftsAreValidatedAsGivenAndTypesKeepTheirNames() throws Exception {
    ContactsEditor.Draft ok = draft(" Ada ", list("number", "+1 (555) 555-0100", "mobile", "5550101", "custom:Boat"), list("address", "ada@example.test", "work"));
    require(ok.displayName.equals(" Ada ") && ok.phones.size() == 2 && ok.phones.get(1).type.equals("custom:Boat") && ok.emails.get(0).value.equals("ada@example.test"), "kept exactly");
    require(draft("", list("number", "5550101", "home"), new JSONArray()).displayName.isEmpty(), "a number alone is a contact");
    invalid("an empty contact", () -> draft("", new JSONArray(), new JSONArray()));
    invalid("a missing name", () -> draft(null, list("number", "5550101", "home"), new JSONArray()));
    invalid("a blank name", () -> draft("  ", list("number", "5550101", "home"), new JSONArray()));
    invalid("a name over the bound", () -> draft("x".repeat(257), new JSONArray(), new JSONArray()));
    invalid("a control character", () -> draft("Ada\u0000", new JSONArray(), new JSONArray()));
    invalid("a blank number", () -> draft("Ada", list("number", " ", "home"), new JSONArray()));
    invalid("a number over the bound", () -> draft("Ada", list("number", "5".repeat(65), "home"), new JSONArray()));
    invalid("an unknown type", () -> draft("Ada", list("number", "5550101", "satellite"), new JSONArray()));
    invalid("an empty custom label", () -> draft("Ada", list("number", "5550101", "custom:"), new JSONArray()));
    invalid("a phone-only type on an email", () -> draft("Ada", new JSONArray(), list("address", "a@example.test", "pager")));
    invalid("an unknown key", () -> draft("Ada", new JSONArray().put(new JSONObject().put("number", "5550101").put("type", "home").put("primary", true)), new JSONArray()));
    invalid("a missing list", () -> draft("Ada", null, new JSONArray()));
    JSONArray many = new JSONArray();
    for (int i = 0; i < 33; i++) many.put(new JSONObject().put("number", "555010" + i).put("type", "home"));
    invalid("more than 32 numbers", () -> draft("Ada", many, new JSONArray()));

    for (int type = 1; type < ContactsEditor.PHONE_TYPES.length; type++)
      require(ContactsEditor.typeValue(ContactsEditor.PHONE_TYPES, ContactsEditor.typeName(ContactsEditor.PHONE_TYPES, type, null)) == type, "phone type " + type + " round-trips");
    require(ContactsEditor.typeName(ContactsEditor.PHONE_TYPES, 2, null).equals("mobile") && ContactsEditor.typeName(ContactsEditor.EMAIL_TYPES, 2, null).equals("work"), "Android's values");
    require(ContactsEditor.typeName(ContactsEditor.PHONE_TYPES, 0, "Boat").equals("custom:Boat") && ContactsEditor.typeValue(ContactsEditor.PHONE_TYPES, "custom:Boat") == 0, "custom label kept");
    require(ContactsEditor.typeName(ContactsEditor.PHONE_TYPES, 0, " ").equals("other") && ContactsEditor.typeName(ContactsEditor.PHONE_TYPES, 99, null).equals("other"), "unlabelled or unknown reads other");
  }

  @Test public void aNewContactIsCreatedAndReadBackWithItsVersion() throws Exception {
    JSObject saved = off(() -> editor.save(null, null, draft("Ada Lovelace", list("number", "+15555550100", "mobile", "5550101", "custom:Boat"), list("address", "ada@example.test", "work"))));
    require(saved.getString("status").equals("saved") && saved.getString("id").equals("101"), "saved with the new contact's id");
    JSObject contact = get("101");
    require(contact.length() == 7, "exactly the contract's fields");
    require(contact.getString("displayName").equals("Ada Lovelace") && contact.getString("lookup").equals("key101") && !contact.getBoolean("starred"), "summary");
    require(contact.getJSONArray("phoneNumbers").toString().equals("[{\"number\":\"+15555550100\",\"type\":\"mobile\"},{\"number\":\"5550101\",\"type\":\"custom:Boat\"}]"), "typed numbers");
    require(contact.getJSONArray("emailAddresses").toString().equals("[{\"address\":\"ada@example.test\",\"type\":\"work\"}]"), "typed addresses");
    require(contact.getString("version").equals(saved.getString("version")), "the saved version is the one a read returns");
    require(data.get(3L).get("data3").equals("Boat") && Integer.valueOf(0).equals(data.get(3L).get("data2")), "custom type stored with its label");
    try { get("999"); } catch (ContactsEditor.NotFound expected) { return; }
    throw new AssertionError("a missing contact is not an empty one");
  }

  @Test public void aSaveChangesOnlyWhatDiffersAndReturnsANewVersion() throws Exception {
    long raw = addRaw(0);
    long name = addData(raw, NAME, "Ada", null, null), kept = addData(raw, PHONE, "5550100", 2, null), dropped = addData(raw, PHONE, "5550101", 1, null);
    long mail = addData(raw, EMAIL, "ada@example.test", 2, null);
    String version = get("101").getString("version");
    writes = 0;
    JSObject saved = off(() -> editor.save("101", version, draft("Ada", list("number", "5550100", "mobile", "5550102", "work"), list("address", "ada@example.test", "work"))));
    require(saved.getString("status").equals("saved") && saved.getString("id").equals("101") && !saved.getString("version").equals(version), "saved with a new version");
    require(data.containsKey(name) && data.containsKey(kept) && data.containsKey(mail) && !data.containsKey(dropped), "untouched rows stay; the removed number is deleted");
    require(writes == 2, "one delete and one insert, nothing else");
    JSObject after = get("101");
    require(after.getJSONArray("phoneNumbers").toString().equals("[{\"number\":\"5550100\",\"type\":\"mobile\"},{\"number\":\"5550102\",\"type\":\"work\"}]"), "numbers as saved");
    require(after.getString("version").equals(saved.getString("version")), "current version");

    writes = 0;
    JSObject renamed = off(() -> editor.save("101", saved.getString("version"), draft("Ada King", list("number", "5550100", "mobile", "5550102", "work"), list("address", "ada@example.test", "work"))));
    require(renamed.getString("status").equals("saved") && get("101").getString("displayName").equals("Ada King") && writes == 2, "the name alone is rewritten");
  }

  @Test public void committedSavesStillReportSavedWhenReadbackFails() throws Exception {
    refuseReadback = true;
    ContactsEditor.Draft original = draft("Ada", new JSONArray(), new JSONArray());
    JSObject created = off(() -> editor.save(null, null, original));
    require(created.getString("status").equals("saved") && created.isNull("id") && created.isNull("version"), "committed creation with no readback");
    require(raws.size() == 1, "one contact was written");

    String version = get("101").getString("version");
    ContactsEditor.Draft renamed = draft("Ada King", new JSONArray(), new JSONArray());
    JSObject edited = off(() -> editor.save("101", version, renamed));
    require(edited.getString("status").equals("saved") && edited.isNull("id") && edited.isNull("version"), "committed update with no readback");
    require(get("101").getString("displayName").equals("Ada King"), "the update was written");
  }

  @Test public void aLostBatchReplyCannotClaimThatACommittedWriteFailed() throws Exception {
    ContactsEditor.Draft original = draft("Ada", new JSONArray(), new JSONArray());
    loseBatchReply = true;
    JSObject created = off(() -> editor.save(null, null, original));
    require(raws.size() == 1, "creation committed before the reply was lost");
    require(created.getString("status").equals("unknown"), "creation outcome is unknown, not safe to retry");

    String version = get("101").getString("version");
    JSObject edited = off(() -> editor.save("101", version, draft("Ada King", new JSONArray(), new JSONArray())));
    require(get("101").getString("displayName").equals("Ada King"), "edit committed before the reply was lost");
    require(edited.getString("status").equals("unknown"), "edit outcome is unknown");

    String editedVersion = get("101").getString("version");
    JSObject removed = off(() -> editor.remove("101", editedVersion));
    require(raws.isEmpty(), "deletion committed before the reply was lost");
    require(removed.getString("status").equals("unknown"), "deletion outcome is unknown");
  }

  @Test public void mergingOrReplacingRawContactsDuringDeleteMakesItStale() throws Exception {
    long original = addRaw(0);
    long other = addRaw(0);
    String version = get("101").getString("version");

    // Aggregation changes only CONTACT_ID. Neither raw contact's version changes.
    beforeBatch = () -> raws.get(other)[0] = 101;
    JSObject merged = off(() -> editor.remove("101", version));
    require(merged.getString("status").equals("stale") && writes == 0 && raws.size() == 2, "a newly merged contact was not deleted");

    raws.get(other)[0] = 102;
    beforeBatch = () -> {
      raws.get(original)[0] = 102;
      raws.get(other)[0] = 101;
    };
    JSObject replaced = off(() -> editor.remove("101", version));
    require(replaced.getString("status").equals("stale") && writes == 0 && raws.size() == 2, "the replacement contact was not deleted");
  }

  @Test public void aContactThatChangedIsStaleAndNothingIsWritten() throws Exception {
    long raw = addRaw(0);
    addData(raw, NAME, "Ada", null, null);
    addData(raw, PHONE, "5550100", 2, null);
    String version = get("101").getString("version");
    ContactsEditor.Draft edit = draft("Ada", list("number", "5550199", "mobile"), new JSONArray());

    // Changed before the save: refused from the version read.
    addData(raw, EMAIL, "ada@example.test", 1, null);
    writes = 0;
    require(off(() -> editor.save("101", version, edit)).toString().equals("{\"status\":\"stale\"}"), "an old version is stale");
    require(off(() -> editor.remove("101", version)).toString().equals("{\"status\":\"stale\"}"), "and cannot delete");
    require(writes == 0 && data.size() == 3, "nothing written");

    // Changed between the version read and the write: refused by the batch's own assert.
    String current = get("101").getString("version");
    beforeBatch = () -> addData(raw, PHONE, "5550777", 1, null);
    writes = 0;
    require(off(() -> editor.save("101", current, edit)).toString().equals("{\"status\":\"stale\"}"), "a concurrent change is stale");
    require(writes == 0 && data.size() == 4, "the other writer's row is all that changed");
    String latest = get("101").getString("version");
    beforeBatch = () -> raws.get(raw)[1]++;
    require(off(() -> editor.remove("101", latest)).getString("status").equals("stale") && raws.containsKey(raw), "a concurrent change keeps the contact");

    // A merged raw contact changes the version too.
    String merged = get("101").getString("version");
    addRaw(101);
    require(off(() -> editor.save("101", merged, edit)).getString("status").equals("stale"), "a newly merged raw contact is a change");
  }

  @Test public void removalNeedsTheCurrentVersionAndReportsAMissingContact() throws Exception {
    long raw = addRaw(0);
    addData(raw, NAME, "Ada", null, null);
    String version = get("101").getString("version");
    require(off(() -> editor.save("555", version, draft("Ada", new JSONArray(), new JSONArray()))).toString().equals("{\"status\":\"not-found\"}"), "saving a missing contact");
    require(off(() -> editor.remove("555", version)).toString().equals("{\"status\":\"not-found\"}"), "removing a missing contact");
    require(off(() -> editor.remove("101", version)).toString().equals("{\"status\":\"deleted\"}") && raws.isEmpty(), "deleted");
    require(off(() -> editor.remove("101", version)).getString("status").equals("not-found"), "already gone");
    invalid("a version of another shape", () -> off(() -> editor.remove("101", "1")));
    invalid("a save without a version", () -> off(() -> editor.save("101", null, draft("Ada", new JSONArray(), new JSONArray()))));
  }

  @Test public void aContactLargerThanTheEditorReadsIsRefusedNotClipped() throws Exception {
    long raw = addRaw(0);
    addData(raw, NAME, "Ada", null, null);
    for (int i = 0; i < 33; i++) addData(raw, PHONE, "55501" + i, 2, null);
    try { get("101"); throw new AssertionError("33 numbers are not shown as 32"); }
    catch (ContactsEditor.Incomplete partial) { require(partial.reason.equals("too-many-fields"), "typed reason"); }
    String version = ContactsEditor.version(Arrays.asList(new long[] { raw, raws.get(raw)[1] }));
    writes = 0;
    require(off(() -> editor.save("101", version, draft("Ada", new JSONArray(), new JSONArray()))).getString("status").equals("stale") && writes == 0, "and cannot be overwritten");
  }
}
