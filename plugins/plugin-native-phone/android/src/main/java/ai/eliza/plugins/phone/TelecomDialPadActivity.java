package ai.eliza.plugins.phone;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Native dial pad for a host that holds the dialer role and has no dial pad of its own. It answers
 * ACTION_DIAL (with or without a tel: number) and fills the number; the person presses Call. The
 * call goes to Telecom through {@link TelecomDial#originate}, which also owns emergency routing.
 * Nothing is dialed without that press, and a caller-supplied number is shown for review first.
 */
public abstract class TelecomDialPadActivity extends Activity {
 /** The heading above the number, for example the product name. */
 protected abstract String title();

 private EditText number;
 private TextView notice;

 private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

 @Override protected void onCreate(Bundle state) {
  super.onCreate(state);
  LinearLayout content = new LinearLayout(this);
  content.setOrientation(LinearLayout.VERTICAL);
  content.setGravity(Gravity.CENTER_HORIZONTAL);
  content.setPadding(dp(24), dp(32), dp(24), dp(32));
  ScrollView scroll = new ScrollView(this);
  scroll.setFillViewport(true);
  scroll.addView(content);
  scroll.setOnApplyWindowInsetsListener((view, insets) -> {
   view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
   return insets;
  });
  TextView heading = new TextView(this);
  heading.setText(title()); heading.setTextSize(18); heading.setGravity(Gravity.CENTER);
  content.addView(heading);
  number = new EditText(this);
  number.setInputType(InputType.TYPE_CLASS_PHONE);
  number.setTextSize(30); number.setGravity(Gravity.CENTER);
  number.setContentDescription("Phone number");
  content.addView(number, new LinearLayout.LayoutParams(-1, -2));
  for (String digits : new String[] { "123", "456", "789", "*0#" }) {
   LinearLayout row = new LinearLayout(this);
   for (char digit : digits.toCharArray()) {
    Button key = new Button(this);
    key.setText(String.valueOf(digit)); key.setTextSize(24); key.setAllCaps(false);
    key.setOnClickListener(view -> number.getText().insert(Math.max(0, number.getSelectionStart()), String.valueOf(digit)));
    row.addView(key, new LinearLayout.LayoutParams(0, dp(64), 1));
   }
   content.addView(row, new LinearLayout.LayoutParams(-1, -2));
  }
  Button call = new Button(this);
  call.setText("Call"); call.setAllCaps(false); call.setTextColor(Color.WHITE); call.setBackgroundColor(Color.rgb(24, 128, 56));
  call.setMinHeight(dp(56));
  // An overlay must not be able to steer the Call press.
  call.setFilterTouchesWhenObscured(true);
  call.setOnClickListener(view -> place());
  content.addView(call, new LinearLayout.LayoutParams(-1, -2));
  notice = new TextView(this);
  notice.setGravity(Gravity.CENTER); notice.setPadding(dp(8), dp(12), dp(8), dp(12));
  content.addView(notice);
  setContentView(scroll);
  accept(getIntent());
 }

 @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); accept(intent); }

 private void accept(Intent intent) {
  Uri data = intent == null ? null : intent.getData();
  String supplied = data != null && "tel".equals(data.getScheme()) ? data.getSchemeSpecificPart() : "";
  number.setText(supplied == null ? "" : supplied);
  number.setSelection(number.getText().length());
  notice.setText("");
 }

 private void place() {
  String value = number.getText().toString().replaceAll("[\\s().-]", "");
  if (!value.matches("\\+?[0-9*#]{1,40}")) { notice.setText("Enter a phone number."); return; }
  switch (TelecomDial.originate(this, Uri.fromParts("tel", value, null))) {
   case PLACED: notice.setText("Calling. Android shows the call."); break;
   case REFUSED: notice.setText("Android did not allow this app to place the call. Choose it as your phone app, or use another dialer."); break;
   default: notice.setText("This phone cannot place calls now.");
  }
 }
}
