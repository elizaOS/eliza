package android.provider;
public final class CalendarContract {public static final String ACCOUNT_TYPE_LOCAL="LOCAL";public static final class Attendees {public static final android.net.Uri CONTENT_URI=new android.net.Uri("attendees");}public static final class Reminders {public static final android.net.Uri CONTENT_URI=new android.net.Uri("reminders");}
 public static final class Calendars {public static final android.net.Uri CONTENT_URI=new android.net.Uri("calendars");public static final int CAL_ACCESS_CONTRIBUTOR=500;public static final String _ID="_id";}
 public static final class Instances {public static final android.net.Uri CONTENT_URI=new android.net.Uri("instances");public static final String CALENDAR_ID="calendar_id",EVENT_ID="event_id",TITLE="title",BEGIN="begin",END="end",ALL_DAY="all_day";}
 public static final class Events {public static final android.net.Uri CONTENT_URI=new android.net.Uri("events");public static final String DELETED="deleted";}
}
