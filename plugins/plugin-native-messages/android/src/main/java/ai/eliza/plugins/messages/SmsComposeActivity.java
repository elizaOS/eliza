package ai.eliza.plugins.messages;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.telephony.SubscriptionInfo;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * The default SMS app's compose screen (SENDTO sms:/smsto: and quick-reply review). It is the review:
 * the owner sees and edits the exact recipients, SIM and text, and only the Send press sends. The send
 * is journaled like every reviewed send ({@link SmsSendJournal}): one operation ID per reviewed
 * content, so a repeated press reads the record and never sends twice, and any edit starts a new
 * review. Several recipients get separate texts, not a group message.
 */
public abstract class SmsComposeActivity extends Activity {
 protected abstract SmsRoleConfiguration configuration();

 private final Handler main = new Handler(Looper.getMainLooper());
 private EditText recipients, body;
 private RadioGroup sims;
 private TextView notice;
 private String operationId;
 private boolean sending;

 private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

 @Override protected void onCreate(Bundle state) {
  super.onCreate(state);
  operationId = state == null ? null : state.getString("operationId");
  LinearLayout content = new LinearLayout(this);
  content.setOrientation(LinearLayout.VERTICAL);
  content.setPadding(dp(20), dp(24), dp(20), dp(24));
  ScrollView scroll = new ScrollView(this);
  scroll.setFillViewport(true);
  scroll.addView(content);
  scroll.setOnApplyWindowInsetsListener((view, insets) -> {
   view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
   return insets;
  });
  TextView to = new TextView(this); to.setText("To (phone numbers, separated by commas)"); content.addView(to);
  recipients = new EditText(this); recipients.setInputType(InputType.TYPE_CLASS_PHONE); recipients.setContentDescription("Recipients"); content.addView(recipients);
  TextView from = new TextView(this); from.setText("From SIM"); from.setPadding(0, dp(12), 0, 0); content.addView(from);
  sims = new RadioGroup(this); content.addView(sims);
  TextView message = new TextView(this); message.setText("Message"); message.setPadding(0, dp(12), 0, 0); content.addView(message);
  body = new EditText(this); body.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
  body.setMinLines(3); body.setGravity(Gravity.TOP); body.setContentDescription("Message text"); content.addView(body);
  TextView charges = new TextView(this); charges.setText("Each recipient gets a separate text. Carrier charges may apply."); content.addView(charges);
  Button send = new Button(this); send.setText("Send"); send.setAllCaps(false); send.setMinHeight(dp(56));
  // An overlay must not be able to steer the owner's Send press.
  send.setFilterTouchesWhenObscured(true);
  send.setOnClickListener(view -> send());
  content.addView(send);
  notice = new TextView(this); notice.setPadding(0, dp(12), 0, 0); content.addView(notice);
  setContentView(scroll);
  if (state == null) prefill(getIntent());
  TextWatcher edited = new TextWatcher() {
   public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
   public void onTextChanged(CharSequence s, int start, int before, int count) {}
   public void afterTextChanged(Editable s) { if (!sending) { operationId = null; } }
  };
  recipients.addTextChangedListener(edited); body.addTextChangedListener(edited);
  sims.setOnCheckedChangeListener((group, id) -> { if (!sending) operationId = null; });
 }

 @Override protected void onResume() { super.onResume(); showSims(); }
 @Override protected void onSaveInstanceState(Bundle state) { super.onSaveInstanceState(state); state.putString("operationId", operationId); }
 @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); if (!sending) { prefill(intent); operationId = null; } }

 private void prefill(Intent intent) {
  Uri data = intent == null ? null : intent.getData();
  String to = data == null ? "" : data.getSchemeSpecificPart();
  if (to != null) { int query = to.indexOf('?'); if (query >= 0) to = to.substring(0, query); }
  recipients.setText(to == null ? "" : Uri.decode(to).replace(';', ','));
  String text = intent == null ? null : intent.getStringExtra("sms_body");
  if (text == null && intent != null) text = intent.getStringExtra(Intent.EXTRA_TEXT);
  body.setText(text == null ? "" : text);
  notice.setText("");
 }

 private void showSims() {
  SmsTelephonyConfiguration telephony = configuration().telephony;
  List<SubscriptionInfo> active = SmsTelephony.activeSubscriptions(this, telephony);
  int checked = sims.getCheckedRadioButtonId();
  sims.removeAllViews();
  if (active == null) { notice.setText("Allow phone-state access so the SIM can be confirmed."); return; }
  int defaultSms = android.telephony.SubscriptionManager.getDefaultSmsSubscriptionId();
  for (SubscriptionInfo info : active) {
   if (info == null || info.getSimSlotIndex() < 0) continue;
   RadioButton option = new RadioButton(this);
   option.setId(info.getSubscriptionId() + 1);
   option.setText("SIM " + (info.getSimSlotIndex() + 1) + " · " + TelephonyPlugin.clip(info.getDisplayName()) + " (" + TelephonyPlugin.clip(info.getCarrierName()) + ")");
   sims.addView(option);
   if (checked == option.getId() || (checked == -1 && (active.size() == 1 || info.getSubscriptionId() == defaultSms))) sims.check(option.getId());
  }
 }

 private String blocker(SmsTelephonyConfiguration telephony) {
  KeyguardManager lock = getSystemService(KeyguardManager.class);
  if (!telephony.admission.admitted(this)) return TelephonyPlugin.UNAVAILABLE;
  if (lock == null || lock.isDeviceLocked()) return "Unlock the phone to send.";
  if (checkSelfPermission(android.Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) return "This app may not send texts.";
  return null;
 }

 private void send() {
  if (sending) return;
  final SmsTelephonyConfiguration telephony = configuration().telephony;
  String blocked = blocker(telephony);
  if (blocked != null) { notice.setText(blocked); return; }
  List<String> numbers = new ArrayList<>();
  for (String raw : recipients.getText().toString().split(",")) { String number = raw.replaceAll("[\\s().-]", ""); if (!number.isEmpty()) numbers.add(number); }
  final String[] to = numbers.toArray(new String[0]);
  final String text = body.getText().toString();
  final int subscription = sims.getCheckedRadioButtonId() - 1;
  try { SmsSendJournal.validate(operationId == null ? "pending" : operationId, to, text, subscription); }
  catch (IllegalArgumentException invalid) { notice.setText("Enter up to five phone numbers, a message and a SIM."); return; }
  if (operationId == null) operationId = UUID.randomUUID().toString();
  final String id = operationId;
  sending = true; notice.setText("Sending…");
  try {
   SmsTelephony.WORK.execute(() -> {
    String outcome;
    try {
     SmsSendJournal journal = SmsTelephony.journal(this, telephony);
     SmsSendJournal.Record existing = journal.existing(id, SmsSendJournal.sha256(SmsSendJournal.bindingText(to, text, subscription)));
     if (existing != null) outcome = existing.status();
     else {
      ArrayList<String> parts = SmsTelephony.manager(this, subscription).divideMessage(text);
      if (parts == null || parts.isEmpty() || parts.size() > SmsSendJournal.MAX_PARTS_PER_RECIPIENT) outcome = "too-long";
      else outcome = SmsTelephony.dispatch(this, telephony, journal, id, to, text, subscription, parts, () -> {
       if (blocker(telephony) != null) throw new IllegalStateException("Access changed");
       boolean active = false;
       List<SubscriptionInfo> now = SmsTelephony.activeSubscriptions(this, telephony);
       if (now != null) for (SubscriptionInfo info : now) if (info != null && info.getSubscriptionId() == subscription) active = true;
       if (!active) throw new IllegalStateException("SIM changed");
      }).status();
     }
    } catch (SmsSendJournal.Expired expired) { outcome = "expired"; }
    catch (Exception failed) {
     SmsSendJournal.Record record = null;
     try { record = SmsTelephony.journal(this, telephony).get(id); } catch (Exception unreadable) { /* stays unknown */ }
     outcome = record == null ? "not-sent" : record.status();
    }
    final String status = outcome;
    main.post(() -> { sending = false; notice.setText(label(status)); });
   });
  } catch (java.util.concurrent.RejectedExecutionException closed) { sending = false; notice.setText(label("not-sent")); }
 }

 static String label(String status) {
  switch (status) {
   case "submitted": return "Submitted to Android; sending and delivery are not confirmed.";
   case "sent": return "All parts sent; delivery is not confirmed.";
   case "delivered": return "All parts have delivery confirmation.";
   case "failed": return "Failure reported; some parts may have been sent. Do not repeat automatically.";
   case "too-long": return "This text is too long to send as SMS. Shorten it.";
   case "expired": return "This request is too old to read back. Nothing was sent again.";
   case "not-sent": case "cancelled": case "denied": return "Nothing was sent.";
   default: return "Outcome unknown. Check the recipient before sending again.";
  }
 }
}
