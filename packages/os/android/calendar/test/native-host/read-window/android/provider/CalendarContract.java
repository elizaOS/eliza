package android.provider;
public final class CalendarContract {
 public static final String ACCOUNT_TYPE_LOCAL="LOCAL",EXTRA_EVENT_BEGIN_TIME="beginTime",EXTRA_EVENT_END_TIME="endTime";
 public static final class Calendars {public static final android.net.Uri CONTENT_URI=new android.net.Uri("calendars");public static final int CAL_ACCESS_CONTRIBUTOR=500;public static final String _ID="_id",CALENDAR_DISPLAY_NAME="calendar_displayName",CALENDAR_ACCESS_LEVEL="calendar_access_level",ACCOUNT_NAME="account_name",ACCOUNT_TYPE="account_type";}
 public static final class Instances {public static final android.net.Uri CONTENT_URI=new android.net.Uri("instances");public static final String EVENT_ID="event_id",CALENDAR_ID="calendar_id",TITLE="title",DESCRIPTION="description",EVENT_LOCATION="eventLocation",BEGIN="begin",END="end",ALL_DAY="allDay",RRULE="rrule";}
 public static final class Events {public static final android.net.Uri CONTENT_URI=new android.net.Uri("events");public static final String _ID="_id",DELETED="deleted",CUSTOM_APP_URI="customAppUri",CUSTOM_APP_PACKAGE="customAppPackage",TITLE="title",EVENT_LOCATION="eventLocation";}
}
