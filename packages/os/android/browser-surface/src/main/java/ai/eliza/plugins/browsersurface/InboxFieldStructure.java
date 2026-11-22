package ai.eliza.plugins.browsersurface;

import android.graphics.Matrix;
import android.os.Bundle;
import android.os.LocaleList;
import android.view.View;
import android.view.ViewStructure;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillValue;
import java.util.ArrayList;
import java.util.List;
import java.util.function.IntFunction;

final class InboxFieldStructure extends ViewStructure {
  static final String ORIGIN = "https://westvaleelectric.com";
  static final String NAME_PREFIX = "grace_verification_";
  static final String HINT = "one-time-code";
  private final IntFunction<AutofillId> resolveId;
  private final List<InboxFieldStructure> children = new ArrayList<>();
  private AutofillId id;
  int virtualId = View.NO_ID;
  private String origin, name, htmlType;
  private boolean focused, text, visible = true, enabled = true, input, hinted;
  int left, top, width, height;

  InboxFieldStructure(AutofillId id, IntFunction<AutofillId> resolveId) {
    this.id = id;
    this.resolveId = resolveId;
  }

  InboxFieldStructure selected(String challenge) {
    if (!ORIGIN.equals(origin))
      return null;
    InboxFieldStructure result = null;
    for (InboxFieldStructure field : children) {
      if (field == null)
        return null;
      if (!field.focused)
        continue;
      if (result != null || !field.input || !field.text || !field.visible || !field.enabled || !field.hinted
          || !"text".equals(field.htmlType) || !ORIGIN.equals(field.origin)
          || !(NAME_PREFIX + challenge).equals(field.name) || field.virtualId == View.NO_ID
          || field.id == null || field.width <= 0 || field.height <= 0)
        return null;
      result = field;
    }
    return result;
  }

  @Override
  public int addChildCount(int count) {
    int start = children.size();
    setChildCount(start + count);
    return start;
  }
  @Override
  public void setChildCount(int count) {
    if (count < 0 || count > 256)
      throw new IllegalArgumentException("Unsupported autofill structure");
    while (children.size() < count) children.add(null);
    while (children.size() > count) children.remove(children.size() - 1);
  }
  @Override
  public int getChildCount() {
    return children.size();
  }
  @Override
  public ViewStructure newChild(int index) {
    InboxFieldStructure child = new InboxFieldStructure(null, resolveId);
    children.set(index, child);
    return child;
  }
  @Override
  public ViewStructure asyncNewChild(int index) {
    throw new IllegalArgumentException("Unsupported asynchronous autofill structure");
  }
  @Override
  public void asyncCommit() {}
  @Override
  public AutofillId getAutofillId() {
    return id;
  }
  @Override
  public void setAutofillId(AutofillId value) {
    id = value;
  }
  @Override
  public void setAutofillId(AutofillId parent, int value) {
    virtualId = value;
    id = resolveId.apply(value);
  }
  @Override
  public void setWebDomain(String value) {
    origin = BrowserFieldOrigin.exactHttps(value);
  }
  @Override
  public void setFocused(boolean value) {
    focused = value;
  }
  @Override
  public void setEnabled(boolean value) {
    enabled = value;
  }
  @Override
  public void setVisibility(int value) {
    visible = value == View.VISIBLE;
  }
  @Override
  public void setAutofillType(int value) {
    text = value == View.AUTOFILL_TYPE_TEXT;
  }
  @Override
  public void setAutofillHints(String[] values) {
    hinted = values != null && values.length == 1 && HINT.equals(values[0]);
  }
  @Override
  public void setDimens(int x, int y, int sx, int sy, int w, int h) {
    left = x;
    top = y;
    width = w;
    height = h;
  }
  @Override
  public HtmlInfo.Builder newHtmlInfoBuilder(String tag) {
    input = "input".equals(tag);
    return new HtmlInfo.Builder() {
      @Override
      public HtmlInfo.Builder addAttribute(String key, String value) {
        if (input && "name".equals(key) && value != null && value.matches("grace_verification_[0-9a-f]{32}"))
          name = value;
        if ("type".equals(key))
          htmlType = value;
        return this;
      }
      @Override
      public HtmlInfo build() {
        return null;
      }
    };
  }

  @Override
  public void setHtmlInfo(HtmlInfo info) {}
  @Override
  public Bundle getExtras() {
    return null;
  }
  @Override
  public boolean hasExtras() {
    return false;
  }
  @Override
  public CharSequence getHint() {
    return null;
  }
  @Override
  public CharSequence getText() {
    return null;
  }
  @Override
  public int getTextSelectionStart() {
    return -1;
  }
  @Override
  public int getTextSelectionEnd() {
    return -1;
  }
  @Override
  public void setAccessibilityFocused(boolean value) {}
  @Override
  public void setActivated(boolean value) {}
  @Override
  public void setAlpha(float value) {}
  @Override
  public void setAutofillOptions(CharSequence[] values) {}
  @Override
  public void setAutofillValue(AutofillValue value) {}
  @Override
  public void setCheckable(boolean value) {}
  @Override
  public void setChecked(boolean value) {}
  @Override
  public void setClassName(String value) {}
  @Override
  public void setClickable(boolean value) {}
  @Override
  public void setContentDescription(CharSequence value) {}
  @Override
  public void setContextClickable(boolean value) {}
  @Override
  public void setDataIsSensitive(boolean value) {}
  @Override
  public void setElevation(float value) {}
  @Override
  public void setFocusable(boolean value) {}
  @Override
  public void setHint(CharSequence value) {}
  @Override
  public void setId(int value, String pkg, String type, String entry) {}
  @Override
  public void setInputType(int value) {}
  @Override
  public void setLocaleList(LocaleList value) {}
  @Override
  public void setLongClickable(boolean value) {}
  @Override
  public void setOpaque(boolean value) {}
  @Override
  public void setSelected(boolean value) {}
  @Override
  public void setText(CharSequence value) {}
  @Override
  public void setText(CharSequence value, int start, int end) {}
  @Override
  public void setTextLines(int[] offsets, int[] baselines) {}
  @Override
  public void setTextStyle(float size, int fg, int bg, int style) {}
  @Override
  public void setTransformation(Matrix value) {}
}
