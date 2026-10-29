package ai.eliza.plugins.media;

import android.app.Activity;
import com.getcapacitor.PluginCall;
import java.util.function.Supplier;

/**
 * The bridge contract of {@link SelectedDocuments}: which call fields each operation reads and how
 * a failure is reported. A host plugin keeps its installed plugin name and method names and
 * delegates each {@code @PluginMethod} here. Calls carry only the opaque {@code selectionId};
 * no URI or path is ever accepted from the renderer.
 *
 * <p>The host passes its registry lazily, so a registry that cannot load is reported through the
 * same fixed rejection as a failed operation (restore, describe and forget) instead of a raw
 * exception message.
 */
public final class SelectedDocumentCalls {
  private SelectedDocumentCalls() {}

  public static void restore(PluginCall call, Supplier<SelectedDocuments> documents) {
    try {
      call.resolve(documents.get().restore());
    } catch (RuntimeException error) {
      call.reject("Saved document access is unavailable");
    }
  }

  public static void describe(PluginCall call, Supplier<SelectedDocuments> documents) {
    try {
      call.resolve(documents.get().describeSelected(call.getString("selectionId")));
    } catch (RuntimeException error) {
      call.reject("Saved document access is unavailable");
    }
  }

  public static void rename(PluginCall call, Supplier<SelectedDocuments> documents) {
    call.resolve(documents.get().rename(call.getString("selectionId"), call.getString("name")));
  }

  public static void pdf(PluginCall call, Supplier<SelectedDocuments> documents) {
    call.resolve(documents.get().pdf(call.getString("selectionId"), call.getInt("page", 0)));
  }

  public static void read(PluginCall call, Supplier<SelectedDocuments> documents) {
    call.resolve(documents.get().read(call.getString("selectionId")));
  }

  public static void open(PluginCall call, Supplier<SelectedDocuments> documents,
      Activity activity) {
    call.resolve(documents.get().open(activity, call.getString("selectionId")));
  }

  public static void share(PluginCall call, Supplier<SelectedDocuments> documents,
      Activity activity) {
    call.resolve(documents.get().share(activity, call.getString("selectionId")));
  }

  public static void forget(PluginCall call, Supplier<SelectedDocuments> documents) {
    try {
      documents.get().forget(call.getString("selectionId"));
      call.resolve();
    } catch (RuntimeException error) {
      call.reject("Document access could not be released");
    }
  }
}
