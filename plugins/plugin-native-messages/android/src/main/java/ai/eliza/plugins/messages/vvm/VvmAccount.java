package ai.eliza.plugins.messages.vvm;

import android.content.ComponentName;
import android.telecom.PhoneAccountHandle;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

/**
 * One calling account (a SIM) as the voicemail provider names it: the flattened component of its
 * {@link PhoneAccountHandle} and its ID. {@link #slot} is the name its IMAP account is stored under;
 * it is a digest, so the SIM's identifier is not a file name.
 */
public final class VvmAccount {
 public final String component, id, slot;
 /** The handle the platform gave, or one rebuilt from the stored names; null when the component is unreadable. */
 public final PhoneAccountHandle handle;

 public VvmAccount(PhoneAccountHandle handle) { this(handle.getComponentName().flattenToString(), handle.getId(), handle); }
 public VvmAccount(String component, String id) { this(component, id, null); }
 private VvmAccount(String component, String id, PhoneAccountHandle known) {
  if (component == null || id == null || component.length() > 512 || id.length() > 512) throw new IllegalArgumentException("Invalid calling account");
  this.component = component; this.id = id;
  ComponentName name = ComponentName.unflattenFromString(component);
  this.handle = known != null ? known : name == null ? null : new PhoneAccountHandle(name, id);
  try {
   byte[] digest = MessageDigest.getInstance("SHA-256").digest((component + "\u0000" + id).getBytes(StandardCharsets.UTF_8));
   StringBuilder hex = new StringBuilder();
   for (int i = 0; i < 16; i++) hex.append(Character.forDigit((digest[i] >> 4) & 0xf, 16)).append(Character.forDigit(digest[i] & 0xf, 16));
   slot = hex.toString();
  } catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
 }
 @Override public boolean equals(Object other) { return other instanceof VvmAccount && ((VvmAccount) other).slot.equals(slot); }
 @Override public int hashCode() { return slot.hashCode(); }

 /** The IMAP account a STATUS message issued, and the mailbox generation (UIDVALIDITY) last synced; -1 before the first sync. */
 public static final class Credentials {
  public final String server, user, password; public final int port; public final long uidValidity;
  public Credentials(String server, int port, String user, String password, long uidValidity) {
   this.server = server; this.port = port; this.user = user; this.password = password; this.uidValidity = uidValidity;
  }
  public Credentials withUidValidity(long validity) { return new Credentials(server, port, user, password, validity); }
  String encode() throws org.json.JSONException {
   return new JSONObject().put("srv", server).put("port", port).put("u", user).put("pw", password).put("uidvalidity", uidValidity).toString();
  }
  static Credentials decode(String stored) throws org.json.JSONException {
   JSONObject value = new JSONObject(stored);
   return new Credentials(value.getString("srv"), value.getInt("port"), value.getString("u"), value.getString("pw"), value.optLong("uidvalidity", -1));
  }
 }
}
