package ai.eliza.plugins.contacts;

import android.content.ContentResolver;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.provider.ContactsContract;
import android.util.Base64;
import android.util.Size;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Display-only names for the numbers a Phone, Messages or call screen already shows. Each asked
 * number is matched whole by Android's same-profile phone lookup, never as a search or prefix, and
 * answers only the contact's display name and its Contacts thumbnail as a small JPEG. No contact
 * ID, lookup key, other field, cache or cross-profile lookup, and nothing is logged. Call
 * {@link #resolve} off the main thread; it times out after five seconds.
 */
public final class ContactNames {
 private ContactNames() {}
 public static final int MAX_NUMBERS = 50, MAX_NAME = 256, PHOTO_PX = 96, MAX_PHOTO_BYTES = 32 * 1024;
 private static final Pattern NUMBER = Pattern.compile("^\\+?[0-9]{2,20}$");

 /** The asked numbers: 1 to {@link #MAX_NUMBERS} distinct dial-shaped strings, in their order. */
 public static List<String> numbers(JSONArray raw) throws Exception {
  if (raw == null || raw.length() < 1 || raw.length() > MAX_NUMBERS) throw new IllegalArgumentException("1 to 50 numbers required");
  List<String> numbers = new ArrayList<>(raw.length());
  HashSet<String> seen = new HashSet<>();
  for (int i = 0; i < raw.length(); i++) {
   Object value = raw.get(i);
   if (!(value instanceof String) || !NUMBER.matcher((String) value).matches() || !seen.add((String) value)) throw new IllegalArgumentException("Distinct dial-shaped numbers required");
   numbers.add((String) value);
  }
  return numbers;
 }

 /** {@code {names: [{number, name, photo}]}}, one entry per asked number in its order; {@code name} and {@code photo} are null when the contact has none. */
 public static JSObject resolve(ContentResolver resolver, List<String> numbers, CancellationSignal signal) {
  if (Looper.myLooper() == Looper.getMainLooper()) throw new IllegalStateException("Contact names must be read off the main thread");
  Handler main = new Handler(Looper.getMainLooper());
  Runnable timeout = signal::cancel;
  main.postDelayed(timeout, 5000);
  JSArray names = new JSArray();
  try {
   for (String number : numbers) {
    signal.throwIfCanceled();
    JSObject entry = new JSObject();
    entry.put("number", number);
    String name = null, photo = null;
    Uri lookup = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number));
    try (Cursor row = resolver.query(lookup, new String[] { ContactsContract.PhoneLookup.DISPLAY_NAME, ContactsContract.PhoneLookup.PHOTO_THUMBNAIL_URI }, null, null, null, signal)) {
     if (row != null && row.moveToFirst()) {
      name = displayName(row.getString(0));
      photo = photo(resolver, row.getString(1), signal);
     }
    }
    entry.put("name", name == null ? JSONObject.NULL : name);
    entry.put("photo", photo == null ? JSONObject.NULL : photo);
    names.put(entry);
   }
  } finally {
   main.removeCallbacks(timeout);
  }
  JSObject result = new JSObject();
  result.put("names", names);
  return result;
 }

 private static String displayName(String value) {
  if (value == null) return null;
  String trimmed = value.trim();
  return trimmed.isEmpty() || trimmed.length() > MAX_NAME ? null : trimmed;
 }

 /** The Contacts thumbnail as a {@code data:image/jpeg;base64,} URI of at most {@link #MAX_PHOTO_BYTES}, or null. */
 private static String photo(ContentResolver resolver, String value, CancellationSignal signal) {
  if (value == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null;
  Uri uri = Uri.parse(value);
  if (!"content".equals(uri.getScheme()) || !ContactsContract.AUTHORITY.equals(uri.getAuthority())) return null;
  try {
   Bitmap image = resolver.loadThumbnail(uri, new Size(PHOTO_PX, PHOTO_PX), signal);
   ByteArrayOutputStream bytes = new ByteArrayOutputStream();
   if (!image.compress(Bitmap.CompressFormat.JPEG, 80, bytes) || bytes.size() > MAX_PHOTO_BYTES) return null;
   return "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
  } catch (java.io.IOException | SecurityException | IllegalArgumentException unavailable) {
   return null;
  }
 }
}
