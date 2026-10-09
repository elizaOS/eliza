package ai.eliza.plugins.calendar;

/** Immutable host identity. Changing these values is a storage migration. */
public final class CalendarConfiguration {
 public final String accountName, localCalendarName, displayName, journalName, creationUriPrefix;
 public final int color;
 public CalendarConfiguration(String accountName,String localCalendarName,String displayName,String journalName,String creationUriPrefix,int color) {
  this.accountName=text(accountName);this.localCalendarName=text(localCalendarName);this.displayName=text(displayName);
  if(journalName==null||!journalName.matches("[A-Za-z0-9_-]{1,128}"))throw new IllegalArgumentException("Invalid calendar journal name");
  android.net.Uri uri=android.net.Uri.parse(text(creationUriPrefix));
  if(uri.getScheme()==null||uri.getAuthority()==null||uri.getQuery()!=null||uri.getFragment()!=null||!creationUriPrefix.endsWith("/"))throw new IllegalArgumentException("Invalid calendar creation URI prefix");
  this.journalName=journalName;this.creationUriPrefix=creationUriPrefix;this.color=color;
 }
 private static String text(String value){if(value==null||value.trim().isEmpty()||value.length()>256||value.indexOf(0)>=0)throw new IllegalArgumentException("Invalid calendar configuration");return value;}
}
