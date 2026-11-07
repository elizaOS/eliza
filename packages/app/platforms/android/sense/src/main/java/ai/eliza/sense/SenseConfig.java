package ai.eliza.sense;

import android.content.ComponentName;
import android.content.Context;

/** Product data selects identities; capture, consent and storage policy stay shared. */
final class SenseConfig {
 private SenseConfig(){}
 static ComponentName component(Context context,String name){
  return new ComponentName(context.getPackageName(),BuildConfig.SENSE_COMPONENT_PACKAGE+"."+name);
 }
}
