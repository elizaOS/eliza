package ai.eliza.plugins.passwords;

import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inspector.WindowInspector;
import android.widget.EditText;
import androidx.test.core.app.ActivityScenario;
import example.passwords.host.TransferActivity;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import static org.junit.Assert.*;

/** Synthetic UI grants only: exercises real native views/cancellation, never opens a vault key. */
public final class PasswordEditorInstrumentedTest {
  private static void fields(View view, List<EditText> found) {
    if (view instanceof EditText) found.add((EditText) view);
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) fields(group.getChildAt(i), found);
    }
  }
  @Test public void editorProtectsDraftsRejectsOverlapAndClearsOnStop() throws Exception {
    AtomicInteger cancellations = new AtomicInteger();
    List<EditText> drafts = new ArrayList<>();
    try (ActivityScenario<TransferActivity> scenario = ActivityScenario.launch(TransferActivity.class)) {
      scenario.onActivity(activity -> {
        try {
          PasswordVaultAccess access = PasswordVaultAccess.get(activity);
          access.lock();
          PasswordEditor.Result result = new PasswordEditor.Result() {
            public void saved(String id) { fail("No save requested"); }
            public void cancelled() { cancellations.incrementAndGet(); }
          };
          try { PasswordEditor.open(activity, access, access.ticket(), result); fail("Locked editor admitted"); }
          catch (PasswordVaultAccess.Locked expected) {}
          long ticket = access.begin(); assertTrue(access.complete(ticket, true));
          PasswordEditor.open(activity, access, ticket, result);
          try { PasswordEditor.open(activity, access, ticket, result); fail("Overlapping editor admitted"); }
          catch (PasswordEditor.Busy expected) {}
          for (View root : WindowInspector.getGlobalWindowViews()) {
            List<EditText> candidate = new ArrayList<>(); fields(root, candidate);
            if (candidate.size() != 4) continue;
            WindowManager.LayoutParams layout = (WindowManager.LayoutParams) root.getLayoutParams();
            assertTrue((layout.flags & WindowManager.LayoutParams.FLAG_SECURE) != 0);
            drafts.addAll(candidate);
          }
          assertEquals(4, drafts.size());
          for (EditText draft : drafts) {
            assertFalse(draft.isSaveEnabled());
            assertFalse(draft.isSaveFromParentEnabled());
            assertTrue(draft.getFilterTouchesWhenObscured());
            assertEquals(View.IMPORTANT_FOR_AUTOFILL_NO, draft.getImportantForAutofill());
            draft.setText("synthetic-editor-canary");
          }
          EditText secret = drafts.get(3);
          assertTrue("Password remains masked after single-line configuration", secret.getTransformationMethod() instanceof android.text.method.PasswordTransformationMethod);
          secret.getText().replace(0, secret.length(), "x".repeat(16385));
          assertEquals("An oversize replacement never truncates or changes the original", "synthetic-editor-canary", secret.getText().toString());
          secret.selectAll();
          assertFalse("Secret copy is unavailable", secret.onTextContextMenuItem(android.R.id.copy));
          assertFalse("Secret cut is unavailable", secret.onTextContextMenuItem(android.R.id.cut));
        } catch (Exception failure) { throw new AssertionError(failure); }
      });
      androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().waitForIdleSync();
      scenario.onActivity(activity -> assertNotNull("Oversize edit shows an error", drafts.get(3).getError()));
      scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);
      assertEquals(1, cancellations.get());
      for (EditText draft : drafts) assertEquals("", draft.getText().toString());
      scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED);
      assertEquals(1, cancellations.get());
    }
  }
}
