package android.content.pm;
/** Host stub: tests set {@link #provider} to model resolveContentProvider. */
public class PackageManager {
 public static class NameNotFoundException extends Exception {}
 public static final int GET_SIGNING_CERTIFICATES=0x08000000,SIGNATURE_MATCH=0;
 public ProviderInfo provider;
 /** @hide in AOSP; available to SystemUI. */
 public PackageInfo getPackageInfoAsUser(String pkg,int flags,int user)throws NameNotFoundException{throw new NameNotFoundException();}
 public String[] getPackagesForUid(int uid){return null;}
 public int checkSignatures(String a,String b){return -3;}
 public ProviderInfo resolveContentProvider(String authority,int flags){return provider;}
}
