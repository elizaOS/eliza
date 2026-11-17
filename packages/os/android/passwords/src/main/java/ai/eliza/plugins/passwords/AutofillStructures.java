package ai.eliza.plugins.passwords;

import android.app.assist.AssistStructure;
import ai.eliza.plugins.securestore.nativeonly.PasswordAutofillPolicy;
import android.content.Context;
import android.os.Bundle;
import android.util.Pair;
import android.view.View;
import android.view.ViewStructure;
import android.view.autofill.AutofillValue;
import java.util.Arrays;
import java.util.Collections;

/** Converts framework structures into {@link PasswordFormPolicy.Node} trees. No decisions here. */
final class AutofillStructures {
  private AutofillStructures() {}

  static PasswordFormPolicy.Target evaluate(Context context, AssistStructure structure, boolean forSave) throws PasswordFormPolicy.Rejected {
    if (structure == null || structure.getActivityComponent() == null) throw new PasswordFormPolicy.Rejected("Missing request identity");
    PasswordsConfig config = PasswordsConfig.of(context);
    PasswordFormPolicy.Node root = new PasswordFormPolicy.Node();
    for (int i = 0; i < structure.getWindowNodeCount(); i++) root.add(convert(structure.getWindowNodeAt(i).getRootViewNode(), forSave, 0));
    // The package is the framework-reported Activity owner, never a value from the structure.
    return PasswordFormPolicy.evaluate(structure.getActivityComponent().getPackageName(), config.hostPackage, config.hostIsBrowser, root,
      packageName -> config.trustedBrowser(context, packageName), forSave);
  }

  private static PasswordFormPolicy.Node convert(AssistStructure.ViewNode view, boolean forSave, int depth) throws PasswordFormPolicy.Rejected {
    if (depth > PasswordFormPolicy.MAX_DEPTH) throw new PasswordFormPolicy.Rejected("Form exceeds bounds");
    PasswordFormPolicy.Node node = new PasswordFormPolicy.Node();
    node.id = view.getAutofillId();
    node.webDomain = view.getWebDomain();
    node.webScheme = view.getWebScheme();
    String[] hints = view.getAutofillHints();
    node.hints = hints == null ? Collections.emptyList() : Arrays.asList(hints);
    node.inputType = view.getInputType();
    node.text = view.getAutofillType() == View.AUTOFILL_TYPE_TEXT;
    node.visible = view.getVisibility() == View.VISIBLE;
    node.focused = view.isFocused();
    ViewStructure.HtmlInfo html = view.getHtmlInfo();
    if (html != null && html.getAttributes() != null) {
      for (Pair<String, String> attribute : html.getAttributes()) {
        if (attribute == null || attribute.first == null) continue;
        if ("type".equalsIgnoreCase(attribute.first)) node.htmlType = attribute.second;
        else if ("autocomplete".equalsIgnoreCase(attribute.first)) node.htmlAutocomplete = attribute.second;
      }
    }
    Bundle extras = view.getExtras();
    if (extras != null) {
      Object top = extras.get(PasswordFormPolicy.TOP_ORIGIN_EXTRA);
      if (top != null) node.topOrigin = String.valueOf(top);
      node.fieldOrigin = extras.getString(PasswordAutofillPolicy.FIELD_ORIGIN);
    }
    if (forSave) {
      AutofillValue value = view.getAutofillValue();
      if (value != null && value.isText()) node.value = value.getTextValue().toString();
    }
    for (int i = 0; i < view.getChildCount(); i++) node.add(convert(view.getChildAt(i), forSave, depth + 1));
    return node;
  }
}
