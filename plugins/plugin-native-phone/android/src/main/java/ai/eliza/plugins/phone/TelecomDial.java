package ai.eliza.plugins.phone;

import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.util.Log;

/**
 * Outgoing calls for a host that holds the dialer role. The call goes to Telecom, which owns
 * routing; for an emergency number Telecom and the telephony stack apply their own emergency
 * handling, and the system emergency dialer on the lock screen does not depend on this host.
 */
public final class TelecomDial {
 private static final String TAG = "TelecomDial";
 private TelecomDial() {}

 /** What happened to a dial request. PLACED hands the call to Telecom; it is not a connected call. */
 public enum Outcome { PLACED, REFUSED, UNAVAILABLE }

 /**
  * Places a call to a tel: URI through Telecom on the default outgoing account. Android refuses the
  * placement unless the host holds the dialer role or CALL_PHONE; that refusal is reported, never
  * retried.
  */
 public static Outcome originate(Context context, Uri telUri) {
  if (telUri == null || !"tel".equals(telUri.getScheme())) return Outcome.REFUSED;
  TelecomManager telecom = context.getSystemService(TelecomManager.class);
  if (telecom == null) return Outcome.UNAVAILABLE;
  try {
   Bundle extras = new Bundle();
   PhoneAccountHandle account = telecom.getDefaultOutgoingPhoneAccount(telUri.getScheme());
   if (account != null) extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, account);
   telecom.placeCall(telUri, extras);
   return Outcome.PLACED;
  } catch (SecurityException denied) {
   Log.w(TAG, "placeCall denied; this app does not hold the dialer role or CALL_PHONE.");
   return Outcome.REFUSED;
  }
 }
}
