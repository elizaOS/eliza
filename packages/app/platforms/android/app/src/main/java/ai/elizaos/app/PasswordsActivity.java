/**
 * Provides a native, secret-free entry to installed password managers and Android
 * provider settings. Providers own unlocking, generating, revealing, saving and
 * syncing credentials; Eliza never reads their vault or reports unobserved state.
 */
package ai.elizaos.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public class PasswordsActivity extends Activity {
    private static final String BITWARDEN = "com.x8bit.bitwarden";
    private static final String ONEPASSWORD = "com.onepassword.android";
    private LinearLayout content;

    @Override
    protected void onCreate(Bundle state) {
        setTheme(android.R.style.Theme_Material_NoActionBar);
        super.onCreate(state);
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
    }

    private void render() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(20, 20, 20));
        scroll.setFillViewport(true);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(24);
        content.setPadding(padding, padding, padding, padding);
        scroll.addView(content);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(0, insets.getSystemWindowInsetTop(), 0,
                    insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(scroll);
        scroll.requestApplyInsets();

        text("Passwords & passkeys", 28);
        text("Choose a password manager. It keeps your logins together and asks you to unlock before showing or filling them.", 18);
        provider("Bitwarden", BITWARDEN, "https://bitwarden.com/download/");
        provider("1Password", ONEPASSWORD, "https://1password.com/downloads/android/");

        text("Use saved passwords", 22);
        String selected = Settings.Secure.getString(getContentResolver(), "autofill_service");
        ComponentName component = selected == null ? null : ComponentName.unflattenFromString(selected);
        String selectedName = component == null ? "No autofill provider selected"
                : BITWARDEN.equals(component.getPackageName()) ? "Bitwarden selected for autofill"
                : ONEPASSWORD.equals(component.getPackageName()) ? "1Password selected for autofill"
                : "Another autofill provider is selected";
        text(selectedName + ".", 16);
        button("Choose autofill provider", view -> launch(
                new Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE)
                        .setData(Uri.parse("package:" + getPackageName()))));
        if (Build.VERSION.SDK_INT >= 34) {
            text("For passkeys, open your manager's Settings → Autofill → Passkey management and enable it in Android. Your browser asks the provider to save or use each passkey.", 16);
            button("Android passwords & accounts", view -> launch(new Intent(Settings.ACTION_SYNC_SETTINGS)));
        } else {
            text("Third-party passkey providers require Android 14 or newer. Password autofill is available on this device.", 16);
        }

        text("Everyday help", 22);
        help("Create or save a password", "Open your manager, choose Add login, then Generate password. Save the login with the exact website address. Use that password when creating the website account. Saving a login alone does not create an account.");
        help("Find or view a password", "Open and unlock your manager, search for the website, then open the login. Use the eye button to view a password. In the browser, tap a login field and choose your saved login. Do not paste passwords into chat.");
        help("Change or reset a password", "Start in the website's account security settings, or use its Forgot password link. Generate the replacement with your manager and save the update after the website accepts it. Editing a saved login alone does not change the website password.");
        help("Sync to another device", "Install the same manager on your other device and sign in to the same account and server. Unlock it and use its sync control. Bitwarden's F-Droid build requires manual sync because it does not use Google push notifications. Before replacing or erasing a device, check that a saved login opens on the other device. Eliza cannot verify your vault's sync status.");
        help("Lock your passwords", "Use Lock in your password manager and set its automatic vault timeout. Enable biometric unlock there if you want it. Locking Eliza does not lock a separate password manager.");
        button("Bitwarden backup & recovery", view -> showBackup());
        button("1Password backup help", view -> new AlertDialog.Builder(this)
                .setTitle("1Password backups")
                .setMessage("1Password desktop exports are not encrypted and do not include passkeys. Follow the provider's current backup and transfer instructions. Never upload a vault export to chat. Keep your recovery code separately from your vault.")
                .setPositiveButton("Provider instructions", (dialog, which) -> openWebsite("https://support.1password.com/export/"))
                .setNegativeButton("Back", null).show());
        button("1Password recovery help", view -> openWebsite("https://support.1password.com/recovery-codes/"));
        button("Done", view -> finish());
    }

    private void provider(String name, String packageName, String downloadUrl) {
        Intent intent = getPackageManager().getLaunchIntentForPackage(packageName);
        text(name + (intent == null ? " · Not installed or unavailable" : " · Installed"), 20);
        button(intent == null ? "Get " + name : "Open " + name,
                view -> {
                    Intent current = getPackageManager().getLaunchIntentForPackage(packageName);
                    if (current == null) openWebsite(downloadUrl);
                    else launch(current);
                });
    }

    private void showBackup() {
        new AlertDialog.Builder(this).setTitle("Keep a recovery copy")
                .setMessage("In Bitwarden, use a password-protected encrypted JSON export. Keep its password separately from the vault and store the file somewhere safe. Check the provider's export coverage for passkeys and attachments. Keep your two-step login recovery code separately too. A synced vault is not a backup.")
                .setPositiveButton("Backup instructions", (dialog, which) -> openWebsite("https://bitwarden.com/help/export-your-data/"))
                .setNeutralButton("Recovery instructions", (dialog, which) -> openWebsite("https://bitwarden.com/help/forgot-master-password/"))
                .setNegativeButton("Back", null).show();
    }

    private void openWebsite(String url) {
        launch(new Intent().setClassName(this, "ai.elizaos.app.ElizaBrowserActivity").setAction(Intent.ACTION_VIEW).setData(Uri.parse(url)));
    }

    private void launch(Intent intent) {
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException error) {
            // error-policy:J4 Missing device handlers remain a visible setup failure.
            new AlertDialog.Builder(this).setTitle("Could not open this screen")
                    .setMessage("Open your password manager or Android Settings from the app launcher. This device does not provide the requested shortcut.")
                    .setPositiveButton("OK", null).show();
        }
    }

    private void help(String title, String message) {
        button(title, view -> new AlertDialog.Builder(this).setTitle(title)
                .setMessage(message).setPositiveButton("OK", null).show());
    }

    private void text(String value, int size) {
        TextView label = new TextView(this);
        label.setText(value);
        label.setTextColor(Color.rgb(245, 245, 245));
        label.setTextSize(size);
        label.setPadding(0, dp(12), 0, dp(8));
        content.addView(label);
    }

    private void button(String label, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(17);
        button.setAllCaps(false);
        button.setMinHeight(dp(52));
        button.setTextColor(Color.WHITE);
        button.setBackgroundTintList(new ColorStateList(
                new int[][] { new int[] { android.R.attr.state_pressed }, new int[] {} },
                new int[] { Color.rgb(142, 53, 0), Color.rgb(181, 67, 0) }));
        button.setOnClickListener(listener);
        content.addView(button, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
