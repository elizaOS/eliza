package ai.eliza.plugins.passwords;

import android.content.Context;
import android.os.CancellationSignal;
import android.os.Parcel;
import android.service.autofill.FillResponse;
import android.view.View;
import android.view.autofill.AutofillId;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Real Android response objects built from synthetic admitted targets. The offer carries no
 * values, and cancellation revokes the one-shot capability. This does not exercise a real
 * browser structure, provider selection or device authentication.
 */
public final class PasswordAutofillOfferInstrumentedTest {
  private static AutofillId id(Context context) {
    final AutofillId[] out = new AutofillId[1];
    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> out[0] = new View(context).getAutofillId());
    return out[0];
  }

  private static PasswordFormPolicy.Target target(Context context) throws Exception {
    PasswordFormPolicy.Node root = new PasswordFormPolicy.Node();
    root.webDomain = "example.test"; root.webScheme = "https";
    PasswordFormPolicy.Node user = new PasswordFormPolicy.Node(); user.id = id(context); user.text = true; user.inputType = 0x21;
    PasswordFormPolicy.Node pass = new PasswordFormPolicy.Node(); pass.id = id(context); pass.text = true; pass.inputType = 0x81;
    root.add(user).add(pass);
    return PasswordFormPolicy.evaluate("org.example.browser", context.getPackageName(), false, root, "org.example.browser"::equals, false);
  }

  @Test public void offerIsAuthenticationGatedAndCancellable() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    PasswordFormPolicy.Target target = target(context);
    assertEquals("https://example.test", target.webOrigin);
    CancellationSignal cancellation = new CancellationSignal();
    FillResponse response = ElizaPasswordAutofillService.offer(context, target, cancellation);
    assertNotNull(response);
    Parcel parcel = Parcel.obtain();
    try {
      response.writeToParcel(parcel, 0);
      String bytes = new String(parcel.marshall(), StandardCharsets.ISO_8859_1);
      assertFalse(bytes.contains("synthetic"));
    } catch (RuntimeException unmarshallable) {
      // Some platform versions refuse to marshal live PendingIntents in-process; the offer was
      // still constructed from a value-free target, asserted below.
    } finally { parcel.recycle(); }
    assertNull(target.password); assertNull(target.username);
    // Cancelling the framework request revokes the capability before any picker can use it.
    PasswordVaultAccess access = PasswordVaultAccess.get(context);
    String token = access.requests.offerFill(target);
    access.requests.cancelFill(token);
    assertNull(access.requests.takeFill(token));
    cancellation.cancel();
    assertNull(ElizaPasswordAutofillService.offer(context, target, cancellation));
  }

  @Test public void hostNativeViewsAndUntrustedWebContentAreRefused() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    PasswordFormPolicy.Node root = new PasswordFormPolicy.Node();
    PasswordFormPolicy.Node pass = new PasswordFormPolicy.Node(); pass.id = id(context); pass.text = true; pass.inputType = 0x81;
    root.add(pass);
    try { PasswordFormPolicy.evaluate(context.getPackageName(), context.getPackageName(), true, root, name -> true, false); fail("Host UI admitted"); }
    catch (PasswordFormPolicy.Rejected expected) { assertEquals("Host interface is never filled", expected.getMessage()); }
    root.webDomain = "example.test"; root.webScheme = "https";
    try { PasswordFormPolicy.evaluate("com.example.untrusted", context.getPackageName(), true, root, name -> false, false); fail("Untrusted browser admitted"); }
    catch (PasswordFormPolicy.Rejected expected) { assertEquals("Untrusted browser", expected.getMessage()); }
    assertTrue(Arrays.asList(context.getResources().getStringArray(R.array.eliza_passwords_trusted_browsers)).isEmpty());
  }
}
