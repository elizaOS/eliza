package ai.eliza.plugins.securestore.nativeonly;

import android.content.Context;
import android.os.Parcel;
import android.view.autofill.AutofillValue;
import android.service.autofill.Dataset;
import android.service.autofill.FillResponse;
import android.view.View;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillManager;
import android.widget.RemoteViews;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.Constructor;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real Android response parcelables, synthetic in-memory records; never user credentials. */
public final class PasswordAutofillCompletionInstrumentedTest {
  interface Work { void run() throws Exception; }
  private void main(Work work) {
    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
      try { work.run(); } catch (Exception failure) { throw new AssertionError(failure); }
      finally { PasswordAutofillSessions.invalidate(); }
    });
  }
  private Context context() { return InstrumentationRegistry.getInstrumentation().getTargetContext(); }
  private PasswordAutofillSessions.Session session() throws Exception {
    Constructor<PasswordAutofillRequest> constructor=PasswordAutofillRequest.class.getDeclaredConstructor(String.class,AutofillId.class,AutofillId.class);
    constructor.setAccessible(true);
    PasswordAutofillRequest request=constructor.newInstance("https://example.test",new View(context()).getAutofillId(),new View(context()).getAutofillId());
    return PasswordAutofillSessions.take(PasswordAutofillSessions.create(request));
  }
  private byte[] bytes(FillResponse response) {
    Parcel parcel=Parcel.obtain();
    try { response.writeToParcel(parcel,0);return parcel.marshall(); } finally { parcel.recycle(); }
  }
  private RemoteViews presentation() { return new RemoteViews(context().getPackageName(),android.R.layout.simple_list_item_1); }
  private final class Vault extends PasswordVaultStore {
    JSONObject selected;
    int reads;
    Runnable afterRead=()->{};
    Vault() throws Exception {
      super(context().getCacheDir(),"synthetic-unused-autofill-test-key",new byte[]{1},true);
      selected=new JSONObject().put("id","selected").put("origin","https://example.test").put("username","synthetic-user").put("password","synthetic-secret");
    }
    @Override public synchronized JSONArray list() throws Exception {
      reads++;afterRead.run();
      return new JSONArray().put(selected).put(new JSONObject().put("id","other").put("origin","https://other.test").put("username","other-user"));
    }
    @Override public synchronized JSONObject get(String id) { reads++;afterRead.run();return selected; }
  }
  private void denied(Work work) throws Exception {
    try { work.run(); fail("Expected denied Autofill completion"); } catch(SecurityException expected) { }
  }

  @Test public void exactOriginMetadataAndSingleResult() { main(()->{
    Vault vault=new Vault();PasswordAutofillSessions.Session session=session();
    JSONArray choices=PasswordAutofillCompletion.choices(session,vault,()->true);
    assertEquals(1,choices.length());assertEquals(2,choices.getJSONObject(0).length());
    assertEquals("selected",choices.getJSONObject(0).getString("id"));assertFalse(choices.getJSONObject(0).has("password"));
    AtomicInteger calls=new AtomicInteger();RemoteViews view=presentation();
    FillResponse expected=new FillResponse.Builder().addDataset(new Dataset.Builder(view)
      .setValue(session.request.username,AutofillValue.forText("synthetic-user"))
      .setValue(session.request.password,AutofillValue.forText("synthetic-secret")).build()).build();
    PasswordAutofillCompletion.complete(session,vault,()->true,"selected",view,intent->{
      calls.incrementAndGet();assertFalse(session.valid());
      FillResponse response=intent.getParcelableExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT);
      assertNotNull(response);assertArrayEquals(bytes(expected),bytes(response));
    });
    session.cancelled=false; // Compatibility flag cannot reset the private completion watermark.
    denied(()->PasswordAutofillCompletion.complete(session,vault,()->true,"selected",presentation(),intent->calls.incrementAndGet()));
    assertEquals(1,calls.get());assertEquals(2,vault.reads);
  }); }

  @Test public void authorizationIsRecheckedAfterVaultAccess() { main(()->{
    Vault vault=new Vault();PasswordAutofillSessions.Session session=session();boolean[] allowed={false};
    denied(()->PasswordAutofillCompletion.choices(session,vault,()->allowed[0]));assertEquals(0,vault.reads);
    allowed[0]=true;vault.afterRead=()->allowed[0]=false;
    denied(()->PasswordAutofillCompletion.choices(session,vault,()->allowed[0]));
    allowed[0]=true;
    denied(()->PasswordAutofillCompletion.complete(session,vault,()->allowed[0],"selected",presentation(),intent->fail("No publication")));
    assertTrue(session.valid());
    vault.afterRead=()->{};vault.selected.put("origin","https://other.test");
    denied(()->PasswordAutofillCompletion.complete(session,vault,()->true,"selected",presentation(),intent->fail("Wrong origin")));
    assertTrue(session.valid());
  }); }

  @Test public void cancellationAndReplacementDuringReadRejectPublication() { main(()->{
    Vault vault=new Vault();PasswordAutofillSessions.Session cancelled=session();vault.afterRead=PasswordAutofillSessions::invalidate;
    denied(()->PasswordAutofillCompletion.complete(cancelled,vault,()->true,"selected",presentation(),intent->fail("Cancelled")));
    PasswordAutofillSessions.Session replaced=session();vault.afterRead=()->PasswordAutofillSessions.create(replaced.request);
    denied(()->PasswordAutofillCompletion.complete(replaced,vault,()->true,"selected",presentation(),intent->fail("Replaced")));
    PasswordAutofillSessions.Session pending=session();
    denied(()->PasswordAutofillCompletion.choices(pending,vault,()->{PasswordAutofillSessions.invalidate();return true;}));
  }); }

  @Test public void throwingPublisherCannotRetryOrReenter() { main(()->{
    Vault vault=new Vault();PasswordAutofillSessions.Session session=session();AtomicInteger calls=new AtomicInteger();
    try {
      PasswordAutofillCompletion.complete(session,vault,()->true,"selected",presentation(),intent->{
        calls.incrementAndGet();
        try { denied(()->PasswordAutofillCompletion.complete(session,vault,()->true,"selected",presentation(),again->fail("Reentrant publication"))); }
        catch(Exception failure){throw new AssertionError(failure);}
        throw new IllegalStateException("Synthetic publisher failure");
      });fail("Expected publisher failure");
    }catch(IllegalStateException expected){}
    denied(()->PasswordAutofillCompletion.complete(session,vault,()->true,"selected",presentation(),intent->calls.incrementAndGet()));
    assertEquals(1,calls.get());assertEquals(1,vault.reads);
  }); }
}
