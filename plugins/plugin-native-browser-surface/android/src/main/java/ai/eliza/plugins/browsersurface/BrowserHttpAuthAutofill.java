package ai.eliza.plugins.browsersurface;

import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.ViewStructure;
import android.view.autofill.AutofillValue;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import androidx.annotation.RequiresApi;
import androidx.appcompat.widget.AppCompatEditText;
import java.util.function.BooleanSupplier;

/**
 * Origin-bound password-manager fill for a browser host's native HTTP authentication prompt. The
 * prompt is host-owned native UI, so without an origin a provider would see only the host's
 * package and could save or fill a site password against the app identity.
 *
 * <p>Fields are offered to Android Autofill only while {@code bound} holds: the prompt has a {@link
 * BrowserHttpAuthOrigin.Binding} from an engine-authenticated challenge and that binding still
 * admits the tab. Each bound field reports the exact HTTPS origin of the challenge (web domain and
 * scheme, the top-level origin extra and the per-field origin extra the provider requires).
 * Otherwise the fields are excluded from Autofill, report no hints or origin even to a manual
 * request, and drop late fill values.
 *
 * <p>Values are never read back by this class: the provider receives them through Android's
 * framework, and only after the user picks a credential in the provider's own UI.
 */
@RequiresApi(Build.VERSION_CODES.O)
public final class BrowserHttpAuthAutofill {
  private BrowserHttpAuthAutofill() {}

  /** A username or password field of the prompt. {@code origin} is null when unbound. */
  public static EditText field(Context context, String origin, BooleanSupplier bound,
      boolean password, BrowserAutofillExtras extras) {
    EditText field = new OriginField(context, extras == null ? null : origin, bound, extras);
    field.setSingleLine(true);
    field.setHint(password ? "Password" : "Username");
    // No suggestions or personalised learning; only the password field is a password type, so the
    // provider's policy sees exactly one username and one password.
    field.setInputType(InputType.TYPE_CLASS_TEXT
        | (password ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS));
    field.setImeOptions(EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
    if (origin == null || extras == null) {
      field.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
      return field;
    }
    field.setAutofillHints(password ? View.AUTOFILL_HINT_PASSWORD : View.AUTOFILL_HINT_USERNAME);
    field.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_YES);
    return field;
  }

  /** Exclude the prompt's fields from Autofill once their binding is revoked. */
  public static void exclude(View... fields) {
    for (View field : fields)
      if (field != null)
        field.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
  }

  private static final class OriginField extends AppCompatEditText {
    private final String origin;
    private final BooleanSupplier bound;
    private final BrowserAutofillExtras extras;

    OriginField(Context context, String origin, BooleanSupplier bound, BrowserAutofillExtras extras) {
      super(context);
      this.origin = origin;
      this.bound = bound;
      this.extras = extras;
    }

    private boolean admitted() {
      return origin != null && bound != null && bound.getAsBoolean();
    }

    // View#isImportantForAutofill reads this, so a revoked or unbound field drops out of every request.
    @Override
    public int getImportantForAutofill() {
      return admitted() ? super.getImportantForAutofill() : View.IMPORTANT_FOR_AUTOFILL_NO;
    }

    // Not autofillable at all when unbound: no value-change or save tracking of manually typed text.
    @Override
    public int getAutofillType() {
      return admitted() ? super.getAutofillType() : View.AUTOFILL_TYPE_NONE;
    }

    // A manually typed username or password is never reported to a provider without a binding.
    @Override
    public AutofillValue getAutofillValue() {
      return admitted() ? super.getAutofillValue() : null;
    }

    @Override
    public void onProvideAutofillStructure(ViewStructure structure, int flags) {
      super.onProvideAutofillStructure(structure, flags);
      if (!admitted()) {
        // A manual request includes unimportant views, and TextView reports its full text for
        // Autofill: report a plain, empty, non-fillable field so typed values never leave the host.
        structure.setAutofillHints(null);
        structure.setAutofillType(View.AUTOFILL_TYPE_NONE);
        structure.setAutofillValue(null);
        structure.setText("");
        structure.setDataIsSensitive(true);
        return;
      }
      // ViewStructure parses scheme and host from this value; the port travels in the extras.
      structure.setWebDomain(origin);
      Bundle bundle = structure.getExtras();
      if (bundle == null)
        return;
      bundle.putString(extras.topOrigin, origin);
      bundle.putString(extras.fieldOrigin, origin);
    }

    @Override
    public void autofill(AutofillValue value) {
      if (admitted())
        super.autofill(value);
    }
  }
}
