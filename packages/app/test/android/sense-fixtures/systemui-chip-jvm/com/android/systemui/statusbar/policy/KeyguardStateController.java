package com.android.systemui.statusbar.policy;
public interface KeyguardStateController {
 boolean isShowing(); default boolean isOccluded(){return false;}
 void addCallback(Callback callback);
 interface Callback { default void onKeyguardShowingChanged(){} }
}
