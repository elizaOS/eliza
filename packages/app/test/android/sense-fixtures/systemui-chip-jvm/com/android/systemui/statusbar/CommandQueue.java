package com.android.systemui.statusbar;
import com.android.internal.statusbar.LetterboxDetails;
import com.android.internal.view.AppearanceRegion;
public class CommandQueue {
 public interface Callbacks {
  default void onSystemBarAttributesChanged(int displayId,int appearance,AppearanceRegion[] appearanceRegions,boolean navbarColorManagedByIme,
    int behavior,int requestedVisibleTypes,String packageName,LetterboxDetails[] letterboxDetails){}
  default void showTransient(int displayId,int types,boolean isGestureOnSystemBar){}
  default void abortTransient(int displayId,int types){}
 }
 public void addCallback(Callbacks callbacks){}
}
