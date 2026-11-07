package ai.eliza.sense;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import android.os.IBinder;
import android.os.RemoteException;
import android.os.SystemClock;

/**
 * SystemUI's indicator health lease endpoint (docs/aosp-listening-chip.md). Exported only behind
 * the platform signature permission {@code STATUS_BAR_SERVICE}, re-checked in {@link #call}
 * together with the caller's UID, package and platform signer ({@link IndicatorLease#admitsController}).
 * The host (which holds only LISTENER_CONTROL) and other apps cannot reach it.
 *
 * It accepts visibility acknowledgements only and returns only the lease generation and whether
 * an acknowledgement was accepted. It cannot start, resume or enable listening, change consent or
 * return status, audio or transcripts: a fresh lease is a precondition the policy checks, and a
 * lost lease stops capture until the user resumes.
 */
public class IndicatorLeaseProvider extends ContentProvider {
 static final String STATUS_BAR_SERVICE="android.permission.STATUS_BAR_SERVICE";
 /** The death link of the current generation; replaced (and unlinked) on each acquire. */
 private static IBinder linkedToken;
 private static IBinder.DeathRecipient linkedRecipient;

 @Override public boolean onCreate(){return true;}

 @Override public Bundle call(String method,String arg,Bundle extras){
  Context context=getContext();
  int caller=Binder.getCallingUid();
  boolean holds=context.checkCallingPermission(STATUS_BAR_SERVICE)==PackageManager.PERMISSION_GRANTED;
  long identity=Binder.clearCallingIdentity();
  try{
   PackageManager packages=context.getPackageManager();
   String[] owners=packages.getPackagesForUid(caller);
   boolean platform=owners!=null&&owners.length==1&&packages.checkSignatures("android",owners[0])==PackageManager.SIGNATURE_MATCH;
   if(!IndicatorLease.admitsController(holds,caller,owners,platform))throw new SecurityException("Only SystemUI may hold the listening indicator lease");
   long boot=Listener.leaseBoot(context),now=SystemClock.elapsedRealtime();
   IndicatorLease.Loss before=Listener.lease.verdict(now,boot,false,Listener.screenInteractive);
   Bundle out=new Bundle();
   if(IndicatorLease.ACQUIRE.equals(method)){
    IBinder token=extras==null?null:extras.getBinder(IndicatorLease.KEY_TOKEN);
    if(token==null)throw new IllegalArgumentException("SystemUI token required");
    long generation=Listener.lease.acquire(boot);
    // SystemUI's process dying ends the lease at once instead of waiting for expiry.
    IBinder.DeathRecipient recipient=()->{Listener.lease.binderDied(generation);Listener.refresh(context);};
    synchronized(IndicatorLeaseProvider.class){
     if(linkedToken!=null)try{linkedToken.unlinkToDeath(linkedRecipient,0);}catch(RuntimeException ignored){}
     linkedToken=null;linkedRecipient=null;
     try{token.linkToDeath(recipient,0);linkedToken=token;linkedRecipient=recipient;}
     catch(RemoteException alreadyDead){Listener.lease.binderDied(generation);}
    }
    out.putLong(IndicatorLease.KEY_GENERATION,generation);
   }else if(IndicatorLease.RENEW.equals(method)){
    if(extras==null)throw new IllegalArgumentException("Acknowledgement required");
    out.putBoolean(IndicatorLease.KEY_ACCEPTED,Listener.lease.renew(extras.getLong(IndicatorLease.KEY_GENERATION,-1),now,boot,
     extras.getBoolean(IndicatorLease.KEY_SURFACE,false),extras.getBoolean(IndicatorLease.KEY_CHIP,false),extras.getBoolean(IndicatorLease.KEY_RECORDING,false),
     extras.getString(IndicatorLease.KEY_DISPLAY),extras.getString(IndicatorLease.KEY_REASON)));
   }else if(IndicatorLease.REVOKE.equals(method)){
    Listener.lease.revoke(extras==null?-1:extras.getLong(IndicatorLease.KEY_GENERATION,-1));
   }else throw new IllegalArgumentException("Unknown method");
   out.putLong(IndicatorLease.KEY_RENEW_MS,IndicatorLease.RENEW_MS);
   // Converge only on a change: a loss while capturing latches and stops; a first fresh lease admits a
   // start; the display turning off pauses and a visible surface after it resumes.
   if(before!=Listener.lease.verdict(now,boot,false,Listener.screenInteractive)||Listener.microphoneHeld&&!Listener.observeIndicatorLease(context,now))Listener.refresh(context);
   return out;
  }finally{Binder.restoreCallingIdentity(identity);}
 }

 @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){return null;}
 @Override public String getType(Uri uri){return null;}
 @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
 @Override public int delete(Uri uri,String selection,String[] args){throw new UnsupportedOperationException();}
 @Override public int update(Uri uri,ContentValues values,String selection,String[] args){throw new UnsupportedOperationException();}
}
