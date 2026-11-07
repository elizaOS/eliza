package ai.elizaos.app;

import android.Manifest;
import ai.eliza.plugins.calendar.CalendarConfiguration;
import ai.eliza.plugins.calendar.CalendarPlugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/** App identity only. CalendarProvider operations and journals belong to the shared bridge. */
@CapacitorPlugin(name="ElizaCalendar", permissions={
 @Permission(alias="calendar",strings={Manifest.permission.READ_CALENDAR,Manifest.permission.WRITE_CALENDAR}),
 @Permission(alias="workflowCalendarRead",strings={Manifest.permission.READ_CALENDAR})
})
public final class ElizaCalendarPlugin extends CalendarPlugin {
 public ElizaCalendarPlugin(){super(new CalendarConfiguration(
  "Eliza","eliza-local","On this phone","eliza-calendar-creations-v1","elizaos://calendar-creation/",0xffff6600,2000));}
}
