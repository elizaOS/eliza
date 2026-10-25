package example.passwords.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.autofill.AutofillManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Offline form: no networking, bridge, account, or real sign-in effect. */
public final class LoginActivity extends Activity {
 @Override public void onCreate(Bundle state) {
  super.onCreate(state);
  LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(32, 80, 32, 32);
  TextView title = new TextView(this); title.setText("Synthetic sign-in — local test only"); root.addView(title);
  EditText username = new EditText(this); username.setId(1001); username.setHint("Test username"); username.setContentDescription("Test username"); username.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS); username.setAutofillHints(View.AUTOFILL_HINT_USERNAME); root.addView(username);
  EditText password = new EditText(this); password.setId(1002); password.setHint("Test password"); password.setContentDescription("Test password"); password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD); password.setAutofillHints(View.AUTOFILL_HINT_PASSWORD); root.addView(password);
  Button submit = new Button(this); submit.setText("Submit synthetic form"); root.addView(submit);
  submit.setOnClickListener(view -> { getSystemService(AutofillManager.class).commit(); root.removeAllViews(); TextView done = new TextView(this); done.setText("Synthetic form submitted"); root.addView(done); });
  Button check = new Button(this); check.setText("Check filled values"); root.addView(check);
  check.setOnClickListener(view -> {
   boolean matches = username.getText().toString().equals(getIntent().getStringExtra("expectedUsername")) && password.getText().toString().equals(getIntent().getStringExtra("expectedPassword"));
   TextView receipt = new TextView(this); receipt.setText(matches ? "Both synthetic fields match" : "Synthetic fields do not match"); root.addView(receipt);
  });
  setContentView(root);
 }
}
