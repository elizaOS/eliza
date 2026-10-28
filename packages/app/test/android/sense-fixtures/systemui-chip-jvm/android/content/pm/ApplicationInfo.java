package android.content.pm;
public class ApplicationInfo {
 public static final int FLAG_SYSTEM=1;
 /** @hide in AOSP. */
 public static final int PRIVATE_FLAG_PRIVILEGED=1<<3;
 public int uid=-1,flags,privateFlags;
 public boolean enabled;
}
