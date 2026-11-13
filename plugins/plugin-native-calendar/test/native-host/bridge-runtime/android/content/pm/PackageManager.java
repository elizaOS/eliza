package android.content.pm;
public class PackageManager {public static String editor="calendar.external";public ResolveInfo resolveActivity(android.content.Intent intent,int flags){if(editor==null)return null;ResolveInfo value=new ResolveInfo();value.activityInfo=new ActivityInfo();value.activityInfo.packageName=editor;return value;}}
