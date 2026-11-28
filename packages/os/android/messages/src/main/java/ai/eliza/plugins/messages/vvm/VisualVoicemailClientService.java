package ai.eliza.plugins.messages.vvm;

import android.os.Bundle;
import android.telecom.PhoneAccountHandle;
import android.telephony.VisualVoicemailService;
import android.telephony.VisualVoicemailSms;
import android.util.Log;

import java.util.HashMap;
import java.util.Map;

/**
 * The carrier visual-voicemail client of a host that is the default dialer. Android binds the
 * default dialer's {@link VisualVoicemailService} when a SIM comes into service, when a
 * visual-voicemail SMS arrives, when a SIM is removed and when the service is stopped; this class
 * hands each to {@link VvmController}, which activates the service with the carrier, keeps the
 * IMAP account the carrier issues, and syncs the mailbox into Android's voicemail provider
 * ({@code VoicemailContract}), where {@code VoicemailStore} reads it.
 *
 * A host declares a subclass with the {@code android.telephony.VisualVoicemailService} action behind
 * {@code android.permission.BIND_VISUAL_VOICEMAIL_SERVICE}, and a {@link VisualVoicemailReceiver}
 * subclass; see the module README. Every platform task is finished on every path.
 *
 * Supported: carriers whose configuration names {@code vvm_type_omtp} or {@code vvm_type_cvvm}.
 * Not supported: other types (reported as disabled, so readers see "unsupported"), legacy mode,
 * greetings, PIN change, and carrier transcripts.
 */
@androidx.annotation.RequiresApi(29)
public abstract class VisualVoicemailClientService extends VisualVoicemailService {
 private static final String TAG = "VisualVoicemail";
 private static final int MAX_FIELDS = OmtpSms.MAX_FIELDS;

 /** The host's identity; the same value its {@link VisualVoicemailReceiver} returns. */
 protected abstract VvmConfiguration configuration();

 private interface Call { void to(VvmController controller, Runnable done); }
 /** Forwards one platform callback; the task is finished by the controller, or here when it could not even be reached. */
 private void forward(VisualVoicemailTask task, Call call) {
  Runnable done = task::finish;
  VvmController controller;
  try { controller = VvmController.get(this, configuration()); }
  catch (RuntimeException failed) { Log.w(TAG, "Voicemail client unavailable: " + failed.getClass().getSimpleName()); done.run(); return; }
  call.to(controller, done);
 }

 @Override public void onCellServiceConnected(VisualVoicemailTask task, PhoneAccountHandle handle) {
  forward(task, (controller, done) -> controller.cellServiceConnected(handle, done));
 }

 @Override public void onSmsReceived(VisualVoicemailTask task, VisualVoicemailSms sms) {
  if (sms == null) { task.finish(); return; }
  Map<String, String> fields = null;
  Bundle parsed = sms.getFields();
  if (parsed != null && sms.getPrefix() != null) {
   fields = new HashMap<>();
   for (String key : parsed.keySet()) {
    String value = key == null ? null : parsed.getString(key);
    if (value != null && fields.size() <= MAX_FIELDS) fields.put(key, value);
   }
  }
  final Map<String, String> read = fields;
  forward(task, (controller, done) -> controller.smsReceived(sms.getPhoneAccountHandle(), sms.getPrefix(), read, sms.getMessageBody(), done));
 }

 @Override public void onSimRemoved(VisualVoicemailTask task, PhoneAccountHandle handle) {
  forward(task, (controller, done) -> controller.simRemoved(handle, done));
 }

 @Override public void onStopped(VisualVoicemailTask task) {
  forward(task, (controller, done) -> controller.stopped(done));
 }
}
