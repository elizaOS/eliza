package com.getcapacitor;
/** Test double: a plugin with a fixed context. */
public class Plugin {
 public static android.content.Context context;
 public android.content.Context getContext(){return context;}
 public void load(){}
 protected void handleOnStart(){}
 protected void handleOnStop(){}
 protected void handleOnDestroy(){}
}
