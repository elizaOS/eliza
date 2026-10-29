package ai.eliza.plugins.media;

import android.app.Activity;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.function.Supplier;

/**
 * The bridge contract of {@link SelectedDocuments}: which call fields each operation reads and how
 * a failure is reported. A host plugin keeps its installed plugin name and method names and
 * delegates each {@code @PluginMethod} here. Calls carry only the opaque {@code selectionId};
 * no URI or path is ever accepted from the renderer.
 *
 * <p>The host passes its registry lazily, so a registry that cannot load, or an operation that
 * throws, is reported through a fixed rejection instead of a raw exception message.
 */
public final class SelectedDocumentCalls {
  private SelectedDocumentCalls() {}

  private static final String UNAVAILABLE = "Saved document access is unavailable";

  public static void restore(PluginCall call, Supplier<SelectedDocuments> documents) {
    resolve(call, UNAVAILABLE, () -> documents.get().restore());
  }

  public static void describe(PluginCall call, Supplier<SelectedDocuments> documents) {
    resolve(call, UNAVAILABLE,
        () -> documents.get().describeSelected(call.getString("selectionId")));
  }

  public static void rename(PluginCall call, Supplier<SelectedDocuments> documents) {
    resolve(call, UNAVAILABLE,
        () -> documents.get().rename(call.getString("selectionId"), call.getString("name")));
  }

  public static void pdf(PluginCall call, Supplier<SelectedDocuments> documents) {
    resolve(call, UNAVAILABLE,
        () -> documents.get().pdf(call.getString("selectionId"), call.getInt("page", 0)));
  }

  public static void read(PluginCall call, Supplier<SelectedDocuments> documents) {
    resolve(call, UNAVAILABLE, () -> documents.get().read(call.getString("selectionId")));
  }

  public static void open(PluginCall call, Supplier<SelectedDocuments> documents,
      Activity activity) {
    resolve(call, UNAVAILABLE,
        () -> documents.get().open(activity, call.getString("selectionId")));
  }

  public static void share(PluginCall call, Supplier<SelectedDocuments> documents,
      Activity activity) {
    resolve(call, UNAVAILABLE,
        () -> documents.get().share(activity, call.getString("selectionId")));
  }

  public static void forget(PluginCall call, Supplier<SelectedDocuments> documents) {
    try {
      documents.get().forget(call.getString("selectionId"));
      call.resolve();
    } catch (RuntimeException error) {
      call.reject("Document access could not be released");
    }
  }

  private static void resolve(PluginCall call, String failure, Supplier<JSObject> operation) {
    JSObject value;
    try {
      value = operation.get();
    } catch (RuntimeException error) {
      call.reject(failure);
      return;
    }
    call.resolve(value);
  }
}
