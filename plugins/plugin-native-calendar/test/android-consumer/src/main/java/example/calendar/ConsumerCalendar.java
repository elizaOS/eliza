package example.calendar;

import android.Manifest;
import ai.eliza.plugins.calendar.CalendarConfiguration;
import ai.eliza.plugins.calendar.CalendarPlugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/** Independent host: no Alpha implementation classes or product identifiers. */
@CapacitorPlugin(name="ConsumerCalendar", permissions={
 @Permission(alias="calendar",strings={Manifest.permission.READ_CALENDAR,Manifest.permission.WRITE_CALENDAR}),
 @Permission(alias="workflowCalendarRead",strings={Manifest.permission.READ_CALENDAR})
})
public final class ConsumerCalendar extends CalendarPlugin {
 public ConsumerCalendar(){super(configuration());}
 public static CalendarConfiguration configuration(){return new CalendarConfiguration("Consumer fixture","consumer-local","Fixture calendar","consumer-calendar-creations-v1","calendarfixture://creation/",0xff008866);}
}
