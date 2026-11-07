package ai.eliza.plugins.securestore.nativeonly;

import android.app.assist.AssistStructure;
import android.content.Context;
import android.os.Bundle;
import android.view.View;
import android.view.autofill.AutofillId;
import java.util.*;

/** Never accepts a caller-supplied package name or an unverified webDomain as authority. */
public final class PasswordAutofillRequest {
  public final String origin;
  public final AutofillId username,password;
  private PasswordAutofillRequest(String origin, AutofillId username, AutofillId password) {this.origin=origin;this.username=username;this.password=password;}
  public interface BrowserTrust { boolean trusted(Context context, String packageName); }
  public static PasswordAutofillRequest parse(Context context, AssistStructure structure, BrowserTrust trust) throws Exception {
    if (structure==null || structure.getActivityComponent()==null || !trust.trusted(context,structure.getActivityComponent().getPackageName()) || structure.getWindowNodeCount()!=1) throw new IllegalArgumentException("Untrusted browser");
    List<AssistStructure.ViewNode> nodes=new ArrayList<>(); collect(structure.getWindowNodeAt(0).getRootViewNode(),nodes,0);
    AssistStructure.ViewNode form=null;
    for (AssistStructure.ViewNode node:nodes) {
      Bundle extras=node.getExtras();
      if(extras!=null && extras.containsKey(PasswordAutofillPolicy.VERSION)) {if(form!=null)throw new IllegalArgumentException("Multiple forms");form=node;}
    }
    if(form==null)throw new IllegalArgumentException("Browser origin metadata unavailable");
    Bundle metadata=form.getExtras();
    List<AssistStructure.ViewNode> descendants=new ArrayList<>();collect(form,descendants,0);
    List<PasswordAutofillPolicy.Field> fields=new ArrayList<>();AutofillId username=null,password=null;
    for(AssistStructure.ViewNode node:nodes) {
      if(node.getWebDomain()!=null && !descendants.contains(node))throw new IllegalArgumentException("Multiple documents");
    }
    for(AssistStructure.ViewNode node:descendants) {
      if(node==form)continue;
      if(node.getChildCount()!=0)throw new IllegalArgumentException("Nested document");
      if(node.getAutofillType()!=View.AUTOFILL_TYPE_TEXT)throw new IllegalArgumentException("Unsupported form control");
      if(node.getAutofillId()==null || node.getExtras()==null)throw new IllegalArgumentException("Missing field binding");
      List<String> hints=node.getAutofillHints()==null?List.of():Arrays.asList(node.getAutofillHints());
      fields.add(new PasswordAutofillPolicy.Field(node.getExtras().getString(PasswordAutofillPolicy.FIELD_ORIGIN),node.getWebScheme(),node.getWebDomain(),hints,node.getVisibility()==View.VISIBLE,node.isFocused()));
      if(PasswordAutofillPolicy.role(hints).equals("username"))username=node.getAutofillId();else password=node.getAutofillId();
    }
    String origin=PasswordAutofillPolicy.validate(metadata.getInt(PasswordAutofillPolicy.VERSION),metadata.getString(PasswordAutofillPolicy.ORIGIN),metadata.getString(PasswordAutofillPolicy.TOP_ORIGIN),fields);
    if(username==null || password==null || username.equals(password))throw new IllegalArgumentException("Invalid field ids");
    if(!"https".equals(form.getWebScheme()) || !new java.net.URI(origin).getHost().equalsIgnoreCase(form.getWebDomain()))throw new IllegalArgumentException("Inconsistent form origin");
    return new PasswordAutofillRequest(origin,username,password);
  }
  private static void collect(AssistStructure.ViewNode node,List<AssistStructure.ViewNode> out,int depth) {
    if(depth>20 || out.size()>=200)throw new IllegalArgumentException("Form exceeds bounds");out.add(node);
    for(int i=0;i<node.getChildCount();i++)collect(node.getChildAt(i),out,depth+1);
  }
}
