package ai.eliza.plugins.media;

import android.app.Activity;
import com.getcapacitor.PluginCall;

/**
 * The bridge contract of {@link SelectedDocuments}: which call fields each operation reads and how
 * a failure is reported. A host plugin keeps its installed plugin name and method names and
 * delegates each {@code @PluginMethod} here. Calls carry only the opaque {@code selectionId};
 * no URI or path is ever accepted from the renderer.
 */
public final class SelectedDocumentCalls {
  private SelectedDocumentCalls() {}

  public static void restore(PluginCall call, SelectedDocuments documents) {
    try {
      call.resolve(documents.restore());
    } catch (RuntimeException error) {
      call.reject("Saved document access is unavailable");
    }
  }

  public static void describe(PluginCall call, SelectedDocuments documents) {
    try {
      call.resolve(documents.describeSelected(call.getString("selectionId")));
    } catch (RuntimeException error) {
      call.reject("Saved document access is unavailable");
    }
  }

  public static void rename(PluginCall call, SelectedDocuments documents) {
    call.resolve(documents.rename(call.getString("selectionId"), call.getString("name")));
  }

  public static void pdf(PluginCall call, SelectedDocuments documents) {
    call.resolve(documents.pdf(call.getString("selectionId"), call.getInt("page", 0)));
  }

  public static void read(PluginCall call, SelectedDocuments documents) {
    call.resolve(documents.read(call.getString("selectionId")));
  }

  public static void open(PluginCall call, SelectedDocuments documents, Activity activity) {
    call.resolve(documents.open(activity, call.getString("selectionId")));
  }

  public static void share(PluginCall call, SelectedDocuments documents, Activity activity) {
    call.resolve(documents.share(activity, call.getString("selectionId")));
  }

  public static void forget(PluginCall call, SelectedDocuments documents) {
    try {
      documents.forget(call.getString("selectionId"));
      call.resolve();
    } catch (RuntimeException error) {
      call.reject("Document access could not be released");
    }
  }
}
