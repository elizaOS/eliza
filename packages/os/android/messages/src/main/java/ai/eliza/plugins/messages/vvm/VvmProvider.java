package ai.eliza.plugins.messages.vvm;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.VoicemailContract.Status;
import android.provider.VoicemailContract.Voicemails;

import java.util.ArrayList;
import java.util.List;

/**
 * This source's own rows in Android's voicemail provider. Every URI carries
 * {@code ?source_package=<this app>}, so nothing here reads or changes another source's voicemail
 * even while the host, as default dialer, could.
 */
@androidx.annotation.RequiresApi(29)
final class VvmProvider {
 private VvmProvider() {}
 static final int MAX_ACCOUNTS = 8;
 static final String VOICEMAIL_ACCOUNT = Voicemails.PHONE_ACCOUNT_COMPONENT_NAME + " = ? AND " + Voicemails.PHONE_ACCOUNT_ID + " = ?";
 private static final String STATUS_ACCOUNT = Status.PHONE_ACCOUNT_COMPONENT_NAME + " = ? AND " + Status.PHONE_ACCOUNT_ID + " = ?";

 static Uri voicemails(Context context) { return Voicemails.buildSourceUri(context.getPackageName()); }
 static Uri voicemail(Context context, long row) { return ContentUris.withAppendedId(voicemails(context), row); }
 private static Uri statuses(Context context) { return Status.buildSourceUri(context.getPackageName()); }
 static String[] account(VvmAccount account) { return new String[] { account.component, account.id }; }

 /**
  * Writes this source's status row for one calling account. A null state leaves that column as it
  * is; a first write fills the unnamed ones with "not configured" and working channels. {@code quota}
  * is {@code {used, total}} as the server counts it, or null to leave the quota columns alone.
  */
 static void status(Context context, VvmAccount account, String type, Integer configuration, Integer data, Integer notification, long[] quota) {
  ContentValues values = new ContentValues();
  if (type != null) values.put(Status.SOURCE_TYPE, type);
  if (configuration != null) values.put(Status.CONFIGURATION_STATE, configuration);
  if (data != null) values.put(Status.DATA_CHANNEL_STATE, data);
  if (notification != null) values.put(Status.NOTIFICATION_CHANNEL_STATE, notification);
  if (quota != null) { values.put(Status.QUOTA_OCCUPIED, clamp(quota[0])); values.put(Status.QUOTA_TOTAL, clamp(quota[1])); }
  ContentResolver resolver = context.getContentResolver();
  if (values.size() > 0 && resolver.update(statuses(context), values, STATUS_ACCOUNT, account(account)) > 0) return;
  values.put(Status.SOURCE_PACKAGE, context.getPackageName());
  values.put(Status.PHONE_ACCOUNT_COMPONENT_NAME, account.component);
  values.put(Status.PHONE_ACCOUNT_ID, account.id);
  if (configuration == null) values.put(Status.CONFIGURATION_STATE, Status.CONFIGURATION_STATE_NOT_CONFIGURED);
  if (data == null) values.put(Status.DATA_CHANNEL_STATE, Status.DATA_CHANNEL_STATE_OK);
  if (notification == null) values.put(Status.NOTIFICATION_CHANNEL_STATE, Status.NOTIFICATION_CHANNEL_STATE_OK);
  resolver.insert(statuses(context), values);
 }
 private static int clamp(long value) { return (int) Math.max(Status.QUOTA_UNAVAILABLE, Math.min(Integer.MAX_VALUE, value)); }

 /** Removes one calling account's voicemail rows (and their audio), keeping its status row. */
 static void deleteVoicemails(Context context, VvmAccount account) {
  context.getContentResolver().delete(voicemails(context), VOICEMAIL_ACCOUNT, account(account));
 }
 /** Removes everything this source stored for one calling account: its voicemail rows and its status row. */
 static void forget(Context context, VvmAccount account) {
  deleteVoicemails(context, account);
  context.getContentResolver().delete(statuses(context), STATUS_ACCOUNT, account(account));
 }
 /** Removes everything this source ever stored. */
 static void forgetAll(Context context) {
  context.getContentResolver().delete(voicemails(context), null, null);
  context.getContentResolver().delete(statuses(context), null, null);
 }

 /** The calling accounts this source reports as configured, at most {@link #MAX_ACCOUNTS}. */
 static List<VvmAccount> configured(Context context) {
  List<VvmAccount> accounts = new ArrayList<>();
  try (Cursor cursor = context.getContentResolver().query(statuses(context),
    new String[] { Status.PHONE_ACCOUNT_COMPONENT_NAME, Status.PHONE_ACCOUNT_ID, Status.CONFIGURATION_STATE }, null, null, null)) {
   while (cursor != null && accounts.size() < MAX_ACCOUNTS && cursor.moveToNext()) {
    if (cursor.isNull(0) || cursor.isNull(1) || cursor.isNull(2) || cursor.getInt(2) != Status.CONFIGURATION_STATE_OK) continue;
    accounts.add(new VvmAccount(cursor.getString(0), cursor.getString(1)));
   }
  }
  return accounts;
 }

 /** The calling account of one of this source's voicemail rows; null when the row is not this source's or names none. */
 static VvmAccount accountOf(Context context, long row) {
  try (Cursor cursor = context.getContentResolver().query(voicemail(context, row),
    new String[] { Voicemails.SOURCE_PACKAGE, Voicemails.PHONE_ACCOUNT_COMPONENT_NAME, Voicemails.PHONE_ACCOUNT_ID }, null, null, null)) {
   if (cursor == null || !cursor.moveToFirst() || cursor.isNull(0) || cursor.isNull(1) || cursor.isNull(2)) return null;
   return context.getPackageName().equals(cursor.getString(0)) ? new VvmAccount(cursor.getString(1), cursor.getString(2)) : null;
  }
 }
}
