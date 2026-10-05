package ai.eliza.plugins.securestore.nativeonly;

import android.app.Activity;
import android.content.Context;
import android.os.CancellationSignal;
import android.os.Parcel;
import android.service.autofill.FillResponse;
import android.view.View;
import android.view.autofill.AutofillId;
import android.widget.RemoteViews;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real Android parcelables and cancellation; synthetic fields, no credentials or browser authority. */
public final class PasswordAutofillOfferInstrumentedTest {
  interface Work { void run() throws Exception; }
  private void main(Work work) {
    InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{
      try {work.run();}catch(Exception failure){throw new AssertionError(failure);}
      finally {PasswordAutofillSessions.invalidate();}
    });
  }
  private Context context(){return InstrumentationRegistry.getInstrumentation().getTargetContext();}
  private PasswordAutofillRequest request() throws Exception {
    Constructor<PasswordAutofillRequest> constructor=PasswordAutofillRequest.class.getDeclaredConstructor(String.class,AutofillId.class,AutofillId.class);
    constructor.setAccessible(true);
    return constructor.newInstance("https://example.test",new View(context()).getAutofillId(),new View(context()).getAutofillId());
  }
  private PasswordAutofillSessions.Session current() throws Exception {
    Field field=PasswordAutofillSessions.class.getDeclaredField("current");field.setAccessible(true);
    return (PasswordAutofillSessions.Session)field.get(null);
  }
  private RemoteViews view(){return new RemoteViews(context().getPackageName(),android.R.layout.simple_list_item_1);}

  @Test public void createsParcelableOfferAndCancellationRevokesSession(){main(()->{
    PasswordAutofillRequest request=request();CancellationSignal cancellation=new CancellationSignal();
    FillResponse response=PasswordAutofillOffer.prepare(context(),()->request,cancellation,Activity.class,"test-autofill",this::view);
    assertNotNull(response);PasswordAutofillSessions.Session session=current();assertTrue(session.valid());
    Parcel parcel=Parcel.obtain();try{response.writeToParcel(parcel,0);assertTrue(parcel.dataSize()>0);}finally{parcel.recycle();}
    cancellation.cancel();assertFalse(session.valid());
  });}
  @Test public void cancelledMissingAndUntrustedRequestsNeverBuildPresentation(){main(()->{
    AtomicInteger calls=new AtomicInteger();CancellationSignal cancelled=new CancellationSignal();cancelled.cancel();
    String token=PasswordAutofillSessions.create(request());
    assertNull(PasswordAutofillOffer.prepare(context(),()->{calls.incrementAndGet();return request();},cancelled,Activity.class,"test-autofill",()->{fail("No presentation");return view();}));
    assertNull(PasswordAutofillSessions.take(token));assertEquals(0,calls.get());
    assertNull(PasswordAutofillOffer.create(context(),null,new CancellationSignal(),(c,p)->false,Activity.class,"test-autofill",()->{fail("No presentation");return view();}));
    assertNull(PasswordAutofillOffer.prepare(context(),()->{throw new SecurityException("Untrusted");},new CancellationSignal(),Activity.class,"test-autofill",this::view));
  });}
  @Test public void cancellationOrPresentationFailureCannotLeaveUsableCapability(){main(()->{
    PasswordAutofillRequest request=request();CancellationSignal cancellation=new CancellationSignal();
    assertNull(PasswordAutofillOffer.prepare(context(),()->request,cancellation,Activity.class,"test-autofill",()->{cancellation.cancel();return view();}));
    assertFalse(current().valid());
    assertNull(PasswordAutofillOffer.prepare(context(),()->request,new CancellationSignal(),Activity.class,"test-autofill",()->{throw new IllegalStateException("Synthetic failure");}));
    assertFalse(current().valid());
    assertNull(PasswordAutofillOffer.prepare(context(),()->request,new CancellationSignal(),Activity.class,"test-autofill",()->null));
    assertFalse(current().valid());
  });}
  @Test public void replacedOfferInvalidatesPriorSessionAndOldCancellationCannotCancelNew(){main(()->{
    PasswordAutofillRequest request=request();CancellationSignal old=new CancellationSignal();
    assertNotNull(PasswordAutofillOffer.prepare(context(),()->request,old,Activity.class,"test-autofill",this::view));
    PasswordAutofillSessions.Session first=current();
    assertNotNull(PasswordAutofillOffer.prepare(context(),()->request,new CancellationSignal(),Activity.class,"test-autofill",this::view));
    PasswordAutofillSessions.Session second=current();assertFalse(first.valid());assertTrue(second.valid());
    old.cancel();assertTrue(second.valid());
  });}
}
