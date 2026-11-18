// spec/os/android/deepLinks.md, "Each capture keeps its own receipt, and only a newer capture takes the slot"; spec/os/signIn/browserReturn.md, "Story: Complete a browser sign-in only for the client that started it"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.securestore.nativeonly.JsonCredentialSlots;
import android.content.Context;
import java.io.File;

public final class KeystoreSlot implements SecureSlot {
  public static final String DEEP_LINK = "sign-in:deep-link-receipt";
  public static final String BROWSER_RETURN = "sign-in:browser-return";
  private static final int LIMIT_BYTES = 8192;

  private final JsonCredentialSlots slots;
  private final String name;

  public KeystoreSlot(Context context, String name) {
    this.slots = new JsonCredentialSlots(new File(context.getNoBackupFilesDir(), "eliza-sign-in-returns"), "eliza-sign-in-returns.v1", slot -> LIMIT_BYTES);
    this.name = name;
  }

  @Override public String read() throws Exception { return slots.read(name); }

  @Override public boolean compareExchange(String expected, String value) throws Exception { return slots.compareExchange(name, expected, value); }
}
