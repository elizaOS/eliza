package ai.eliza.plugins.contacts;

import android.content.ContentProviderOperation;
import android.content.ContentProviderResult;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.OperationApplicationException;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Looper;
import android.provider.ContactsContract;
import android.provider.ContactsContract.CommonDataKinds.Email;
import android.provider.ContactsContract.CommonDataKinds.Phone;
import android.provider.ContactsContract.CommonDataKinds.StructuredName;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * One contact read for editing, and owner-driven writes of its name, phone numbers and email
 * addresses, for hosts that edit contacts in their own screen on their AOSP image.
 *
 * {@link #get} returns the contact with an opaque {@code version}: a digest of its raw contacts and
 * their provider versions, which Android raises on every data change, so it differs whenever a name,
 * number, address or the set of merged raw contacts changed. A contact with more than
 * {@link #MAX_FIELDS} numbers or addresses, or a longer field than this class accepts, is refused as
 * {@link Incomplete} instead of being shown clipped; open it in the system Contacts app.
 *
 * {@link #save} and {@link #remove} compare that version first and again inside the provider's own
 * transaction (assert operations in the same batch), so a contact that changed since it was read is
 * answered {@code stale} and nothing is written. A save changes only what differs: rows the draft
 * still names are left untouched (keeping what this class does not model, such as the primary flag),
 * removed rows are deleted, new rows are added to the contact's first raw contact, and the name is
 * rewritten only when the display name changed. A new contact is stored in the device-local account.
 * Nothing is retried. Call every method off the main thread.
 */
public final class ContactsEditor {
  public static final int MAX_FIELDS = 32, MAX_NAME = 256, MAX_NUMBER = 64, MAX_ADDRESS = 320, MAX_LABEL = 64, MAX_RAW_CONTACTS = 64;
  /** Marks a type the owner named themselves: {@code custom:<label>}. */
  public static final String CUSTOM = "custom:";
  static final String FIELD_NOT_EDITABLE = "field-not-editable";
  /** Type names by {@link Phone#TYPE} value; index 0 (custom) is carried as {@link #CUSTOM} plus its label. */
  static final String[] PHONE_TYPES = { null, "home", "mobile", "work", "fax_work", "fax_home", "pager", "other", "callback", "car", "company_main",
    "isdn", "main", "other_fax", "radio", "telex", "tty_tdd", "work_mobile", "work_pager", "assistant", "mms" };
  /** Type names by {@link Email#TYPE} value. */
  static final String[] EMAIL_TYPES = { null, "home", "work", "other", "mobile" };

  /** No contact with this ID. */
  public static final class NotFound extends Exception {
    private static final long serialVersionUID = 1L;
    NotFound() { super("No contact with this ID", null, false, false); }
  }
  /** The contact holds more than this class reads; it is never returned clipped. */
  public static final class Incomplete extends Exception {
    private static final long serialVersionUID = 1L;
    public final String reason;
    Incomplete(String reason) { super(reason, null, false, false); this.reason = reason; }
  }

  private final ContentResolver resolver;
  public ContactsEditor(Context context) { resolver = context.getContentResolver(); }
  private static void offMain() { if (Looper.myLooper() == Looper.getMainLooper()) throw new IllegalStateException("Contacts edits must run off the main thread"); }

  // ---- Types -------------------------------------------------------------------------------------

  /** The contract name of a stored type. A custom type without a label, or a type newer than this table, reads "other". */
  static String typeName(String[] names, int type, String label) {
    if (type == 0 && label != null && !label.trim().isEmpty() && label.length() <= MAX_LABEL) return CUSTOM + label;
    return type > 0 && type < names.length ? names[type] : "other";
  }
  /** The stored type of a contract name: its table index, 0 for {@code custom:<label>}, or -1 when it is neither. */
  static int typeValue(String[] names, String name) {
    if (name == null) return -1;
    if (name.startsWith(CUSTOM)) return clean(name.substring(CUSTOM.length()), MAX_LABEL) ? 0 : -1;
    for (int i = 1; i < names.length; i++) if (names[i].equals(name)) return i;
    return -1;
  }
  /** Non-blank, within the bound and free of control characters. */
  static boolean clean(String value, int max) {
    if (value == null || value.length() > max || value.trim().isEmpty()) return false;
    for (int i = 0; i < value.length(); i++) if (Character.isISOControl(value.charAt(i))) return false;
    return true;
  }

  // ---- Draft -------------------------------------------------------------------------------------

  /** One phone number or email address with its contract type name. */
  static final class Field {
    final String value, type;
    Field(String value, String type) { this.value = value; this.type = type; }
    boolean same(Field other) { return value.equals(other.value) && type.equals(other.type); }
  }
  /** A validated save request. */
  public static final class Draft {
    final String displayName; final List<Field> phones, emails;
    Draft(String displayName, List<Field> phones, List<Field> emails) { this.displayName = displayName; this.phones = phones; this.emails = emails; }
  }
  /**
   * Validates a save request exactly as given: nothing is trimmed, reordered or dropped. Throws
   * IllegalArgumentException for a name over {@link #MAX_NAME} characters, more than
   * {@link #MAX_FIELDS} numbers or addresses, a blank, over-long or control-character field, an
   * unknown type, an unknown key, or a draft with no name, number or address at all.
   */
  public static Draft draft(String displayName, JSONArray phones, JSONArray emails) {
    if (displayName == null || displayName.length() > MAX_NAME || (!displayName.isEmpty() && !clean(displayName, MAX_NAME))) throw new IllegalArgumentException("Invalid contact name");
    List<Field> numbers = fields(phones, "number", MAX_NUMBER, PHONE_TYPES), addresses = fields(emails, "address", MAX_ADDRESS, EMAIL_TYPES);
    if (displayName.isEmpty() && numbers.isEmpty() && addresses.isEmpty()) throw new IllegalArgumentException("Empty contact");
    return new Draft(displayName, numbers, addresses);
  }
  private static List<Field> fields(JSONArray raw, String key, int max, String[] types) {
    if (raw == null || raw.length() > MAX_FIELDS) throw new IllegalArgumentException("Invalid contact fields");
    List<Field> out = new ArrayList<>();
    for (int i = 0; i < raw.length(); i++) {
      JSONObject item = raw.optJSONObject(i);
      if (item == null || item.length() != 2 || !(item.opt(key) instanceof String) || !(item.opt("type") instanceof String)) throw new IllegalArgumentException("Invalid contact field");
      String value = (String) item.opt(key), type = (String) item.opt("type");
      if (!clean(value, max) || typeValue(types, type) < 0) throw new IllegalArgumentException("Invalid contact field");
      out.add(new Field(value, type));
    }
    return out;
  }

  // ---- Version -----------------------------------------------------------------------------------

  /**
   * The opaque version of a contact from its raw contacts as {@code {rawContactId, version}} pairs in
   * any order: a SHA-256 over the pairs sorted by ID. It changes when any pair changes, is added or
   * is removed.
   */
  public static String version(List<long[]> rawContacts) {
    List<long[]> sorted = new ArrayList<>(rawContacts);
    sorted.sort((a, b) -> Long.compare(a[0], b[0]));
    StringBuilder text = new StringBuilder("contact.v1");
    for (long[] raw : sorted) text.append(';').append(raw[0]).append(':').append(raw[1]);
    try {
      byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(text.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
      StringBuilder hex = new StringBuilder(64);
      for (byte b : digest) hex.append(Character.forDigit((b >> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
      return hex.toString();
    } catch (java.security.NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }
  /** A contact ID as the provider's row, or -1. */
  public static long row(String id) { return id != null && id.matches("[1-9][0-9]{0,17}") ? Long.parseLong(id) : -1; }
  /** A version string this class could have issued. */
  public static boolean versionShape(String version) { return version != null && version.matches("[0-9a-f]{64}"); }

  // ---- Reads -------------------------------------------------------------------------------------

  private static final String LIVE_CONTACT = ContactsContract.RawContacts.CONTACT_ID + "=? AND " + ContactsContract.RawContacts.DELETED + "=0";

  /** {rawContactId, version} of every live raw contact of the contact, lowest ID first; empty when the contact is gone. */
  private List<long[]> rawContacts(long contact, CancellationSignal cancel) {
    List<long[]> out = new ArrayList<>();
    try (Cursor rows = resolver.query(ContactsContract.RawContacts.CONTENT_URI, new String[] { ContactsContract.RawContacts._ID, ContactsContract.RawContacts.VERSION },
        LIVE_CONTACT, new String[] { String.valueOf(contact) }, ContactsContract.RawContacts._ID + " ASC", cancel)) {
      if (rows == null) throw new IllegalStateException("Contacts provider unavailable");
      while (rows.moveToNext()) {
        if (out.size() >= MAX_RAW_CONTACTS) throw new IllegalStateException("Too many merged contacts");
        out.add(new long[] { rows.getLong(0), rows.getLong(1) });
      }
    }
    return out;
  }
  /** A stored phone or email row. */
  private static final class Stored {
    final long dataId; final Field field;
    Stored(long dataId, Field field) { this.dataId = dataId; this.field = field; }
  }
  private List<Stored> stored(long contact, String mime, String[] types, int max, CancellationSignal cancel) throws Incomplete {
    List<Stored> out = new ArrayList<>();
    try (Cursor rows = resolver.query(ContactsContract.Data.CONTENT_URI, new String[] { ContactsContract.Data._ID, ContactsContract.Data.DATA1, ContactsContract.Data.DATA2, ContactsContract.Data.DATA3 },
        ContactsContract.Data.CONTACT_ID + "=? AND " + ContactsContract.Data.MIMETYPE + "=?", new String[] { String.valueOf(contact), mime }, ContactsContract.Data._ID + " ASC", cancel)) {
      if (rows == null) throw new IllegalStateException("Contact fields unavailable");
      while (rows.moveToNext()) {
        if (out.size() >= MAX_FIELDS) throw new Incomplete(ContactsCatalog.TOO_MANY_FIELDS);
        String value = rows.getString(1);
        if (value != null && value.length() > max) throw new Incomplete(ContactsCatalog.FIELD_TOO_LONG);
        // A field this class would refuse to write back (blank, or with control characters) is not offered for editing.
        if (!clean(value, max)) throw new Incomplete(FIELD_NOT_EDITABLE);
        out.add(new Stored(rows.getLong(0), new Field(value, typeName(types, rows.isNull(2) ? -1 : rows.getInt(2), rows.getString(3)))));
      }
    }
    return out;
  }
  private static JSArray json(List<Stored> rows, String key) {
    JSArray out = new JSArray();
    for (Stored row : rows) {
      JSObject item = new JSObject();
      item.put(key, row.field.value);
      item.put("type", row.field.type);
      out.put(item);
    }
    return out;
  }
  /** The contact's display name, or null when the contact is gone. */
  private String[] summary(long contact, CancellationSignal cancel) {
    try (Cursor row = resolver.query(ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, contact),
        new String[] { ContactsContract.Contacts.LOOKUP_KEY, ContactsContract.Contacts.DISPLAY_NAME_PRIMARY, ContactsContract.Contacts.STARRED }, null, null, null, cancel)) {
      if (row == null) throw new IllegalStateException("Contacts provider unavailable");
      if (!row.moveToFirst()) return null;
      return new String[] { row.getString(0), row.getString(1) == null ? "" : row.getString(1), row.getInt(2) != 0 ? "1" : "0" };
    }
  }

  /** {@code {id, lookup, displayName, starred, phoneNumbers: [{number, type}], emailAddresses: [{address, type}], version}}. */
  public JSObject get(String id, CancellationSignal cancel) throws NotFound, Incomplete {
    offMain();
    long contact = row(id);
    if (contact < 0) throw new IllegalArgumentException("Selected contact required");
    // The version is read first: a change during the read leaves an older version, which a save refuses as stale.
    List<long[]> raws = rawContacts(contact, cancel);
    String[] summary = summary(contact, cancel);
    if (raws.isEmpty() || summary == null) throw new NotFound();
    if (summary[0] == null || summary[0].length() > 1024 || summary[1].length() > MAX_NAME) throw new Incomplete(ContactsCatalog.FIELD_TOO_LONG);
    JSObject out = new JSObject();
    out.put("id", id);
    out.put("lookup", summary[0]);
    out.put("displayName", summary[1]);
    out.put("starred", summary[2].equals("1"));
    out.put("phoneNumbers", json(stored(contact, Phone.CONTENT_ITEM_TYPE, PHONE_TYPES, MAX_NUMBER, cancel), "number"));
    out.put("emailAddresses", json(stored(contact, Email.CONTENT_ITEM_TYPE, EMAIL_TYPES, MAX_ADDRESS, cancel), "address"));
    out.put("version", version(raws));
    return out;
  }

  // ---- Writes ------------------------------------------------------------------------------------

  private static JSObject status(String status) {
    JSObject out = new JSObject();
    out.put("status", status);
    return out;
  }
  private static ContentProviderOperation insert(long rawContact, Integer backReference, String mime, String[] types, Field field) {
    ContentProviderOperation.Builder op = ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValue(ContactsContract.Data.MIMETYPE, mime);
    if (backReference != null) op.withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, backReference);
    else op.withValue(ContactsContract.Data.RAW_CONTACT_ID, rawContact);
    if (types == null) return op.withValue(StructuredName.DISPLAY_NAME, field.value).build();
    int type = typeValue(types, field.type);
    op.withValue(ContactsContract.Data.DATA1, field.value).withValue(ContactsContract.Data.DATA2, type);
    if (type == 0) op.withValue(ContactsContract.Data.DATA3, field.type.substring(CUSTOM.length()));
    return op.build();
  }
  /** Deletes the stored rows the draft no longer names and inserts the draft's rows that are not stored; equal rows stay untouched. */
  private static void replace(ArrayList<ContentProviderOperation> ops, List<Stored> current, List<Field> wanted, long rawContact, String mime, String[] types) {
    List<Field> missing = new ArrayList<>(wanted);
    for (Stored row : current) {
      int kept = -1;
      for (int i = 0; i < missing.size() && kept < 0; i++) if (missing.get(i).same(row.field)) kept = i;
      if (kept >= 0) missing.remove(kept);
      else ops.add(ContentProviderOperation.newDelete(ContentUris.withAppendedId(ContactsContract.Data.CONTENT_URI, row.dataId)).build());
    }
    for (Field field : missing) ops.add(insert(rawContact, null, mime, types, field));
  }
  /** Fails the transaction unless both the aggregate membership and each member's version still match. */
  private static void assertUnchanged(ArrayList<ContentProviderOperation> ops, long contact, List<long[]> raws) {
    ops.add(ContentProviderOperation.newAssertQuery(ContactsContract.RawContacts.CONTENT_URI)
      .withSelection(LIVE_CONTACT, new String[] { String.valueOf(contact) })
      .withExpectedCount(raws.size()).build());
    for (long[] raw : raws)
      ops.add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(ContactsContract.RawContacts.CONTENT_URI, raw[0]))
        .withValue(ContactsContract.RawContacts.CONTACT_ID, contact)
        .withValue(ContactsContract.RawContacts.VERSION, raw[1]).withExpectedCount(1).build());
  }
  /**
   * Why a batch was rolled back, with nothing written: true when a version assert failed because the
   * contact changed after it was read; false when the provider refused an operation of an unchanged contact.
   */
  private boolean changedSince(long contact, String version) {
    try {
      return !version(rawContacts(contact, null)).equals(version);
    } catch (RuntimeException unreadable) {
      return false;
    }
  }
  /** The transaction committed. A failed or incomplete readback only withholds the contact and version. */
  private JSObject saved(Uri rawContact) {
    JSObject out = status("saved");
    if (rawContact != null) {
      try {
        long contact = -1;
        try (Cursor row = resolver.query(rawContact, new String[] { ContactsContract.RawContacts.CONTACT_ID }, null, null, null)) {
          if (row != null && row.moveToFirst() && !row.isNull(0)) contact = row.getLong(0);
        }
        if (contact > 0) {
          List<long[]> raws = rawContacts(contact, null);
          if (!raws.isEmpty()) {
            out.put("id", String.valueOf(contact));
            out.put("version", version(raws));
            return out;
          }
        }
      } catch (RuntimeException unreadable) {
        // The provider can disappear or revoke read access after it committed the write.
      }
    }
    out.put("id", JSONObject.NULL);
    out.put("version", JSONObject.NULL);
    return out;
  }

  /**
   * Creates the contact when {@code id} is null, otherwise applies the draft to the contact read at
   * {@code version}. Answers {@code {status: "saved", id, version}}, {@code {status: "stale"}} (the
   * contact changed; nothing written), {@code {status: "not-found"}} or {@code {status: "failed"}}
   * (the provider refused the batch; nothing written), or {@code {status: "unknown"}} when the
   * dispatched batch's reply was lost. An unknown write may have committed and must not be retried
   * without reading the provider again.
   */
  public JSObject save(String id, String version, Draft draft) {
    offMain();
    ArrayList<ContentProviderOperation> ops = new ArrayList<>();
    if (id == null) {
      ops.add(ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
        .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null).withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null).build());
      if (!draft.displayName.isEmpty()) ops.add(insert(0, 0, StructuredName.CONTENT_ITEM_TYPE, null, new Field(draft.displayName, "")));
      for (Field phone : draft.phones) ops.add(insert(0, 0, Phone.CONTENT_ITEM_TYPE, PHONE_TYPES, phone));
      for (Field email : draft.emails) ops.add(insert(0, 0, Email.CONTENT_ITEM_TYPE, EMAIL_TYPES, email));
      final ContentProviderResult[] results;
      try {
        results = resolver.applyBatch(ContactsContract.AUTHORITY, ops);
      } catch (OperationApplicationException refused) {
        return status("failed");
      } catch (android.os.RemoteException | RuntimeException lostReply) {
        return status("unknown");
      }
      return saved(results != null && results.length > 0 && results[0] != null ? results[0].uri : null);
    }
    long contact = row(id);
    if (contact < 0 || !versionShape(version)) throw new IllegalArgumentException("Selected contact and version required");
    final List<long[]> raws; final String[] summary; final List<Stored> phones, emails;
    try {
      raws = rawContacts(contact, null);
      summary = summary(contact, null);
      if (raws.isEmpty() || summary == null) return status("not-found");
      if (!version(raws).equals(version)) return status("stale");
      phones = stored(contact, Phone.CONTENT_ITEM_TYPE, PHONE_TYPES, MAX_NUMBER, null);
      emails = stored(contact, Email.CONTENT_ITEM_TYPE, EMAIL_TYPES, MAX_ADDRESS, null);
    } catch (Incomplete partial) {
      // get() never offered this contact for editing, so no version of it can be current.
      return status("stale");
    } catch (RuntimeException unreadable) {
      return status("failed");
    }
    assertUnchanged(ops, contact, raws);
    long target = raws.get(0)[0];
    if (!draft.displayName.equals(summary[1])) {
      String[] args = new String[raws.size() + 1];
      StringBuilder in = new StringBuilder();
      for (int i = 0; i < raws.size(); i++) { args[i] = String.valueOf(raws.get(i)[0]); in.append(i == 0 ? "?" : ",?"); }
      args[raws.size()] = StructuredName.CONTENT_ITEM_TYPE;
      ops.add(ContentProviderOperation.newDelete(ContactsContract.Data.CONTENT_URI)
        .withSelection(ContactsContract.Data.RAW_CONTACT_ID + " IN (" + in + ") AND " + ContactsContract.Data.MIMETYPE + "=?", args).build());
      if (!draft.displayName.isEmpty()) ops.add(insert(target, null, StructuredName.CONTENT_ITEM_TYPE, null, new Field(draft.displayName, "")));
    }
    replace(ops, phones, draft.phones, target, Phone.CONTENT_ITEM_TYPE, PHONE_TYPES);
    replace(ops, emails, draft.emails, target, Email.CONTENT_ITEM_TYPE, EMAIL_TYPES);
    try {
      resolver.applyBatch(ContactsContract.AUTHORITY, ops);
    } catch (OperationApplicationException rolledBack) {
      return status(changedSince(contact, version) ? "stale" : "failed");
    } catch (android.os.RemoteException | RuntimeException lostReply) {
      return status("unknown");
    }
    return saved(ContentUris.withAppendedId(ContactsContract.RawContacts.CONTENT_URI, target));
  }

  /** Deletes the contact read at {@code version}: an unknown reply may have committed the deletion. */
  public JSObject remove(String id, String version) {
    offMain();
    long contact = row(id);
    if (contact < 0 || !versionShape(version)) throw new IllegalArgumentException("Selected contact and version required");
    final List<long[]> raws;
    try {
      raws = rawContacts(contact, null);
    } catch (RuntimeException unreadable) {
      return status("failed");
    }
    if (raws.isEmpty()) return status("not-found");
    if (!version(raws).equals(version)) return status("stale");
    ArrayList<ContentProviderOperation> ops = new ArrayList<>();
    assertUnchanged(ops, contact, raws);
    ops.add(ContentProviderOperation.newDelete(ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, contact)).build());
    try {
      ContentProviderResult[] results = resolver.applyBatch(ContactsContract.AUTHORITY, ops);
      Integer count = results.length == ops.size() ? results[results.length - 1].count : null;
      return status(count != null && count > 0 ? "deleted" : "not-found");
    } catch (OperationApplicationException rolledBack) {
      return status(changedSince(contact, version) ? "stale" : "failed");
    } catch (android.os.RemoteException | RuntimeException lostReply) {
      return status("unknown");
    }
  }
}
