package ai.eliza.plugins.securestore.nativeonly;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.CancellationSignal;
import android.service.autofill.FillRequest;
import android.service.autofill.FillResponse;
import android.view.autofill.AutofillId;
import android.widget.RemoteViews;
import java.util.function.Supplier;

/** Native-only authentication offers. Hosts supply browser trust and picker presentation;
 * no vault access or secret material is involved in creating an offer. */
public final class PasswordAutofillOffer {
  private PasswordAutofillOffer() {}
  @FunctionalInterface interface RequestSource { PasswordAutofillRequest read() throws Exception; }

  public static FillResponse create(Context context, FillRequest input, CancellationSignal cancellation,
      PasswordAutofillRequest.BrowserTrust trust, Class<? extends Activity> picker,
      String tokenScheme, Supplier<RemoteViews> presentation) {
    return prepare(context, () -> {
      if(input==null || input.getFillContexts().isEmpty())return null;
      return PasswordAutofillRequest.parse(context,
        input.getFillContexts().get(input.getFillContexts().size()-1).getStructure(), trust);
    }, cancellation, picker, tokenScheme, presentation);
  }

  /** Package seam exercises real Android response construction with synthetic requests. */
  static FillResponse prepare(Context context, RequestSource source, CancellationSignal cancellation,
      Class<? extends Activity> picker, String tokenScheme, Supplier<RemoteViews> presentation) {
    PasswordAutofillSessions.invalidate();
    String token=null;
    PendingIntent pending=null;
    boolean offered=false;
    try {
      if(cancellation==null || cancellation.isCanceled())return null;
      if(tokenScheme==null || !tokenScheme.matches("[A-Za-z][A-Za-z0-9+.-]*"))return null;
      PasswordAutofillRequest request=source.read();
      if(request==null || cancellation.isCanceled())return null;
      token=PasswordAutofillSessions.create(request);
      final String capability=token;
      cancellation.setOnCancelListener(()->PasswordAutofillSessions.cancel(capability));
      Intent intent=new Intent(context,picker).setData(Uri.fromParts(tokenScheme,token,null));
      pending=PendingIntent.getActivity(context,0,intent,PendingIntent.FLAG_ONE_SHOT|PendingIntent.FLAG_IMMUTABLE);
      RemoteViews view=presentation.get();
      if(view==null || cancellation.isCanceled())return null;
      FillResponse response=new FillResponse.Builder().setAuthentication(
        new AutofillId[]{request.username,request.password},pending.getIntentSender(),view).build();
      if(cancellation.isCanceled())return null;
      offered=true;
      return response;
    }catch(Exception rejected){return null;}
    finally {
      if(!offered){
        if(token!=null)PasswordAutofillSessions.cancel(token);
        if(pending!=null)pending.cancel();
      }
    }
  }
}
