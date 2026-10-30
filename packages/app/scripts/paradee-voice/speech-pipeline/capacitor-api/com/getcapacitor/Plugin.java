package com.getcapacitor;
public class Plugin {
 public android.content.Context getContext(){throw new UnsupportedOperationException();}
 public void load(){}
 protected void notifyListeners(String eventName,JSObject data){throw new UnsupportedOperationException();}
 public PermissionState getPermissionState(String alias){throw new UnsupportedOperationException();}
 protected void requestPermissionForAlias(String alias,PluginCall call,String callbackName){throw new UnsupportedOperationException();}
 @PluginMethod public void requestPermissions(PluginCall call){throw new UnsupportedOperationException();}
 protected void handleOnResume(){}
 protected void handleOnPause(){}
 protected void handleOnDestroy(){}
}
