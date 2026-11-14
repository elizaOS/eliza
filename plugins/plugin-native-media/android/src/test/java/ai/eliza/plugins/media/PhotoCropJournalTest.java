package ai.eliza.plugins.media;

import static org.junit.Assert.*;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import java.lang.reflect.Method;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

/** Exact engine geometry and durable crop identity. MediaStore publication has consumer tests. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public final class PhotoCropJournalTest {
  @Test public void malformedRectangleCannotFallBackToADifferentLegacyCrop() throws Exception {
    Method crop = PhotosPlugin.class.getDeclaredMethod("crop", com.getcapacitor.PluginCall.class); crop.setAccessible(true);
    for (Object malformed : new Object[] {"not a rectangle", JSONObject.NULL, new org.json.JSONArray(),
        new JSONObject().put("x", "0.25").put("y", 0).put("width", .5).put("height", .5)}) {
      com.getcapacitor.PluginCall call = new com.getcapacitor.PluginCall(null, "Photos", "review", "saveEdit", new com.getcapacitor.JSObject().put("crop", true).put("cropRect", malformed));
      try { crop.invoke(null, call); fail("Malformed rectangle silently changed the selected edit"); }
      catch (java.lang.reflect.InvocationTargetException refused) { assertTrue(refused.getCause() instanceof IllegalArgumentException); }
    }
    com.getcapacitor.PluginCall legacy = new com.getcapacitor.PluginCall(null, "Photos", "review", "saveEdit", new com.getcapacitor.JSObject().put("crop", true));
    assertSame(PhotoCrop.CENTER, crop.invoke(null, legacy));
  }
  @Test public void invalidEdgeCropNeverBecomesASelection() {
    for (double[] rect : new double[][] {{1, 0, 1e-12, .5}, {0, 1, .5, 1e-12},
        {1 + 1e-12, 0, 1e-12, .5}, {0, 1 + 1e-12, .5, 1e-12}}) {
      try { PhotoCrop.rect(rect[0], rect[1], rect[2], rect[3]); fail("Out-of-photo origin accepted"); }
      catch (IllegalArgumentException expected) { /* Refused before any journal or provider effect. */ }
    }
  }
  @Test public void chosenRectangleUsesTheRotatedPixels() throws Exception {
    Context context = RuntimeEnvironment.getApplication();
    OwnedPhotoEdits edits = new OwnedPhotoEdits(context, OwnedMediaConfig.builder("cropgeometry").edits("Pictures/Review/", "edit-").captures("Pictures/Review/", "capture-").build());
    Bitmap source = Bitmap.createBitmap(8, 4, Bitmap.Config.ARGB_8888);
    source.eraseColor(Color.RED);
    Method geometry = OwnedPhotoEdits.class.getDeclaredMethod("geometry", Bitmap.class, int.class, PhotoCrop.class); geometry.setAccessible(true);
    Bitmap cropped = (Bitmap) geometry.invoke(edits, source, 90, PhotoCrop.rect(0.25, 0, 0.5, 0.5));
    try { assertEquals(2, cropped.getWidth()); assertEquals(4, cropped.getHeight()); assertEquals(Color.RED, cropped.getPixel(0, 0)); }
    finally { if (cropped != source) cropped.recycle(); source.recycle(); edits.close(); }
  }
  @Test public void durableCropReceiptBindsTheExactSelectionAndKeepsLegacyFlags() throws Exception {
    Context context = RuntimeEnvironment.getApplication();
    Method put = OwnedPhotoEdits.class.getDeclaredMethod("putCrop", JSONObject.class, PhotoCrop.class); put.setAccessible(true);
    Method same = OwnedPhotoEdits.class.getDeclaredMethod("sameCrop", JSONObject.class, PhotoCrop.class); same.setAccessible(true);
    android.content.SharedPreferences journal = context.getSharedPreferences("crop-receipt", 0);
    PhotoCrop chosen = PhotoCrop.rect(0.25, 0.1, 0.5, 0.4);
    JSONObject reserved = (JSONObject) put.invoke(null, new JSONObject().put("status", "writing"), chosen);
    assertTrue(journal.edit().putString("operation", reserved.toString()).commit());
    JSONObject restored = new JSONObject(context.getSharedPreferences("crop-receipt", 0).getString("operation", null));
    assertEquals(true, same.invoke(null, restored, PhotoCrop.rect(0.25, 0.1, 0.5, 0.4)));
    assertEquals(false, same.invoke(null, restored, PhotoCrop.rect(0.25, 0.1, 0.5, 0.41)));
    assertEquals(false, same.invoke(null, restored, PhotoCrop.CENTER));
    assertEquals(false, same.invoke(null, restored, PhotoCrop.NONE));
    assertEquals(true, same.invoke(null, new JSONObject().put("crop", true), PhotoCrop.CENTER));
    assertEquals(true, same.invoke(null, new JSONObject().put("crop", false), PhotoCrop.NONE));
    assertEquals(false, same.invoke(null, new JSONObject().put("crop", true), chosen));
  }
}
