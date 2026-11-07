package com.android.systemui.settings;
import android.content.Context;
import java.util.concurrent.Executor;
public interface UserTracker {
 interface Callback { default void onBeforeUserSwitching(int newUser){} default void onUserChanged(int newUser,Context userContext){} }
 int getUserId();
 boolean isUserSwitching();
 void addCallback(Callback callback,Executor executor);
}
