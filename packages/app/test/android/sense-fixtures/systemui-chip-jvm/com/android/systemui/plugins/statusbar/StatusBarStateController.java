package com.android.systemui.plugins.statusbar;
public interface StatusBarStateController {
 boolean isExpanded();
 boolean isDozing();
 void addCallback(StateListener listener);
 interface StateListener {
  default void onStateChanged(int newState){}
  default void onExpandedChanged(boolean isExpanded){}
  default void onDozingChanged(boolean isDozing){}
 }
}
