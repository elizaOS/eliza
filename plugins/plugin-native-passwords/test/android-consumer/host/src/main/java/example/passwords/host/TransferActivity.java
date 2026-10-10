package example.passwords.host;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import ai.eliza.plugins.passwords.PasswordsPlugin;
import ai.eliza.plugins.passwords.PasswordTransferPlugin;

/** Offline fixture using the real Capacitor plugins and Android document picker. */
public final class TransferActivity extends BridgeActivity {
 @Override public void onCreate(Bundle state) {
  registerPlugin(PasswordsPlugin.class);
  registerPlugin(PasswordTransferPlugin.class);
  super.onCreate(state);
 }
}
