package ai.eliza.sense;

import android.app.ActivityOptions;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;

/**
 * Opens the host's existing user-facing assistant surface (its ACTION_ASSIST activity) when the user
 * addresses it. The intent carries no transcript, audio or other content: the host starts its own
 * foreground voice turn. The listener shares its identity so the host can record the invocation as
 * coming from the listener, and refuses to invoke a host package not signed like this one.
 */
final class AssistantInvocation {
 private AssistantInvocation(){}
 static final String ASSIST_ACTIVITY=BuildConfig.SENSE_ASSIST_ACTIVITY;

 static boolean start(Context context){
  PackageManager packages=context.getPackageManager();
  if(packages.checkSignatures(context.getPackageName(),Listener.HOST_PACKAGE)!=PackageManager.SIGNATURE_MATCH)return false;
  Intent intent=new Intent(Intent.ACTION_ASSIST).setComponent(new ComponentName(Listener.HOST_PACKAGE,ASSIST_ACTIVITY))
   .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
  ActivityOptions options=ActivityOptions.makeBasic().setShareIdentityEnabled(true);
  try{context.startActivity(intent,options.toBundle());return true;}
  catch(ActivityNotFoundException|SecurityException refused){return false;}
 }
}
