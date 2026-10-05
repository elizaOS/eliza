package ai.eliza.plugins.securestore.nativeonly;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real Android Bundle/Looper/Handler; synthetic challenge port, never device credentials. */
public final class DeviceCredentialSessionInstrumentedTest {
  private static final class Host implements DeviceCredentialSession.Challenge, DeviceCredentialSession.Listener {
    int code = -1, launches, destinations, locks;
    boolean secure = true, unavailable, failLaunch;
    DeviceCredentialSession.Unavailable reason;
    public boolean secure() { return secure; }
    public Intent create(CharSequence title, CharSequence message) { return unavailable ? null : new Intent(); }
    public void launch(Intent intent, int code) { launches++; this.code = code; if (failLaunch) throw new IllegalStateException("Synthetic launch failure"); }
    public void locked() { locks++; }
    public void unavailable(DeviceCredentialSession.Unavailable reason) { this.reason = reason; }
  }
  @Test public void staleResultsExpiryAndStop() {
    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
      Host host = new Host(); long[] now = {100};
      try (DeviceCredentialSession session = new DeviceCredentialSession(host,110000,731,750,null,host,()->now[0])) {
        Runnable destination = () -> host.destinations++;
        session.authenticate("Test", "Synthetic", destination); int old = host.code; assertTrue(session.challengePending());
        session.authenticate("Test", "Synthetic", destination); assertEquals(1,host.launches);
        session.onStop(); assertFalse(session.authenticated());
        assertTrue(session.onActivityResult(old,Activity.RESULT_OK)); assertEquals(1,host.destinations);
        assertFalse(session.challengePending()); assertTrue(session.authenticated());
        now[0]+=110000; assertFalse(session.authenticated()); // Timer has not run.
        session.authenticate("Test", "Synthetic", destination); int next = host.code;
        assertTrue(next>old);
        session.onActivityResult(old,Activity.RESULT_OK); assertFalse(session.authenticated());
        session.onActivityResult(next,Activity.RESULT_OK); assertEquals(2,host.destinations);
        session.onActivityResult(next,Activity.RESULT_OK); assertEquals(2,host.destinations);
        session.onStop(); assertFalse(session.authenticated());
        session.authenticate("Test", "Synthetic", destination); int cancelled=host.code;
        session.lock(); session.onActivityResult(cancelled,Activity.RESULT_OK); assertEquals(2,host.destinations);
        assertFalse(session.onActivityResult(999,Activity.RESULT_OK));
      }
    });
  }
  @Test public void expiryWhileArmingTimerDoesNotInvokeAuthenticatedDestination() {
    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
      Host host = new Host(); int[] reads = {0};
      try (DeviceCredentialSession session = new DeviceCredentialSession(host,10,731,750,null,host,()->reads[0]++ == 0 ? 100 : 110)) {
        session.authenticate("Test", "Synthetic", () -> host.destinations++);
        session.onActivityResult(host.code, Activity.RESULT_OK);
        assertFalse(session.authenticated());
        assertEquals(0, host.destinations);
        assertTrue(host.locks > 0);
      }
    });
  }
  @Test public void recreationSavesOnlyCounterAndExhaustionNeverWraps() {
    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
      Host host = new Host(); Bundle saved = new Bundle();
      DeviceCredentialSession previous=new DeviceCredentialSession(host,110000,731,732,null,host,()->100);
      previous.authenticate("Test","Synthetic",()->host.destinations++); int old=host.code;
      previous.saveState(saved); previous.close();
      assertEquals(1,saved.keySet().size());
      try(DeviceCredentialSession session=new DeviceCredentialSession(host,110000,731,732,saved,host,()->100)) {
        assertFalse(session.authenticated());
        session.authenticate("Test","Synthetic",()->host.destinations++); int next=host.code;
        assertTrue(next>old);
        session.onActivityResult(old,Activity.RESULT_OK); assertEquals(0,host.destinations);
        session.onActivityResult(next,Activity.RESULT_OK); assertEquals(1,host.destinations);
        session.authenticate("Test","Synthetic",()->host.destinations++);
        assertEquals(DeviceCredentialSession.Unavailable.CHALLENGE_UNAVAILABLE,host.reason);
        assertFalse(session.authenticated()); assertEquals(2,host.launches);
      }
      try(DeviceCredentialSession missing=new DeviceCredentialSession(host,110000,731,732,new Bundle(),host,()->100)) {
        missing.authenticate("Test","Synthetic",()->host.destinations++);
        assertEquals(2,host.launches); // Unknown restored counter fails closed.
      }
    });
  }
  @Test public void unavailableAndDestroyedChallengesNeverGrant() {
    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
      Host host=new Host();
      DeviceCredentialSession session=new DeviceCredentialSession(host,110000,731,750,null,host,()->100);
      host.secure=false;session.authenticate("Test","Synthetic",()->host.destinations++);
      assertEquals(DeviceCredentialSession.Unavailable.DEVICE_LOCK_REQUIRED,host.reason);
      host.secure=true;host.unavailable=true;session.authenticate("Test","Synthetic",()->host.destinations++);
      assertEquals(DeviceCredentialSession.Unavailable.CHALLENGE_UNAVAILABLE,host.reason);
      host.unavailable=false;host.failLaunch=true;session.authenticate("Test","Synthetic",()->host.destinations++);
      session.onActivityResult(host.code,Activity.RESULT_OK);assertFalse(session.authenticated());
      host.failLaunch=false;session.authenticate("Test","Synthetic",()->host.destinations++);int code=host.code;
      session.close();session.onActivityResult(code,Activity.RESULT_OK);assertEquals(0,host.destinations);
      assertFalse(session.authenticated());
    });
  }
}
