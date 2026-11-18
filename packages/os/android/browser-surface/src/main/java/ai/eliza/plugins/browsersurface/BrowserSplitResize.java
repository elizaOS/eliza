package ai.eliza.plugins.browsersurface;

import androidx.window.WindowSdkExtensions;
import androidx.window.embedding.SplitAttributes;
import androidx.window.embedding.SplitController;
import androidx.window.embedding.SplitInfo;
import java.util.function.BiConsumer;

final class BrowserSplitResize {
    private BrowserSplitResize() {}

    static BiConsumer<SplitInfo, SplitAttributes> forController(SplitController controller) {
        if (WindowSdkExtensions.getInstance().getExtensionVersion() >= 3) {
            return (split, attributes) -> controller.updateSplitAttributes(split, attributes);
        }
        throw new BrowserLaunchException("BROWSER_DOCK_RESIZE_UNAVAILABLE",
                "This device cannot resize the existing browser split.");
    }
}
