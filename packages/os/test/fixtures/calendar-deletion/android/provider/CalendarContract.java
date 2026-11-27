// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package android.provider;

public final class CalendarContract {
  private CalendarContract() {}
  public static final String AUTHORITY = "com.android.calendar";
  public static final String ACCOUNT_TYPE_LOCAL = "LOCAL";
  public static final String CALLER_IS_SYNCADAPTER = "caller_is_syncadapter";
  public static final String EXTRA_EVENT_BEGIN_TIME = "beginTime";
  public static final String EXTRA_EVENT_END_TIME = "endTime";
  public static final String EXTRA_EVENT_ALL_DAY = "allDay";
  private static android.net.Uri content(String path) { return android.net.Uri.parse("content://" + AUTHORITY + "/" + path); }
  public static final class Calendars {
    public static final android.net.Uri CONTENT_URI = content("calendars");
    public static final String _ID = "_id", ACCOUNT_NAME = "account_name", ACCOUNT_TYPE = "account_type", NAME = "name", CALENDAR_DISPLAY_NAME = "calendar_displayName",
      CALENDAR_ACCESS_LEVEL = "calendar_access_level", CALENDAR_COLOR = "calendar_color", CALENDAR_TIME_ZONE = "calendar_timezone", OWNER_ACCOUNT = "ownerAccount",
      VISIBLE = "visible", SYNC_EVENTS = "sync_events";
    public static final int CAL_ACCESS_FREEBUSY = 100, CAL_ACCESS_READ = 200, CAL_ACCESS_CONTRIBUTOR = 500, CAL_ACCESS_OWNER = 700;
  }
  public static final class Events {
    public static final android.net.Uri CONTENT_URI = content("events");
    public static final android.net.Uri CONTENT_EXCEPTION_URI = content("exception");
    public static final String _ID = "_id", CALENDAR_ID = "calendar_id", TITLE = "title", DESCRIPTION = "description", EVENT_LOCATION = "eventLocation", DTSTART = "dtstart",
      DTEND = "dtend", DURATION = "duration", EVENT_TIMEZONE = "eventTimezone", ALL_DAY = "allDay", RRULE = "rrule", DELETED = "deleted", STATUS = "eventStatus",
      ORIGINAL_INSTANCE_TIME = "originalInstanceTime", CUSTOM_APP_URI = "customAppUri", CUSTOM_APP_PACKAGE = "customAppPackage";
    public static final int STATUS_TENTATIVE = 0, STATUS_CONFIRMED = 1, STATUS_CANCELED = 2;
    public static final int AVAILABILITY_BUSY = 0, AVAILABILITY_FREE = 1, AVAILABILITY_TENTATIVE = 2;
  }
  public static final class Instances {
    public static final android.net.Uri CONTENT_URI = content("instances/when");
    public static final String EVENT_ID = "event_id", BEGIN = "begin", END = "end", CALENDAR_ID = "calendar_id", TITLE = "title", ALL_DAY = "allDay", STATUS = "eventStatus",
      SELF_ATTENDEE_STATUS = "selfAttendeeStatus", RRULE = "rrule", EVENT_LOCATION = "eventLocation", DESCRIPTION = "description", AVAILABILITY = "availability";
  }
  public static final class Attendees {
    public static final android.net.Uri CONTENT_URI = content("attendees");
    public static final int ATTENDEE_STATUS_DECLINED = 2;
  }
  public static final class Reminders {
    public static final android.net.Uri CONTENT_URI = content("reminders");
  }
}
