/**
 * Utility functions for date and time operations
 */

/**
 * Checks if a team member is available at the current time
 * @param workDays Array of work days
 * @param workHours Object containing start and end hours
 * @param timeZone Time zone of the team member
 * @returns Boolean indicating if the member is available
 */
export function isAvailableNow(
  workDays: string[],
  workHours: { start: string; end: string },
  timeZone: string
): boolean {
  try {
    const now = new Date();

    // Get the day name in the team member's timezone
    const options: Intl.DateTimeFormatOptions = {
      timeZone,
      weekday: 'long',
    };
    const dayName = new Intl.DateTimeFormat('en-US', options).format(now).split(',')[0];

    // Check if today is a work day
    if (!workDays.includes(dayName)) {
      return false;
    }

    // Get current time in team member's timezone
    const timeOptions: Intl.DateTimeFormatOptions = {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    };
    const currentTime = new Intl.DateTimeFormat('en-US', timeOptions).format(now);

    // Compare with work hours
    const [currentHour, currentMinute] = currentTime.split(':').map(Number);
    const [startHour, startMinute] = workHours.start.split(':').map(Number);
    const [endHour, endMinute] = workHours.end.split(':').map(Number);

    const currentTimeMinutes = currentHour * 60 + currentMinute;
    const startTimeMinutes = startHour * 60 + startMinute;
    const endTimeMinutes = endHour * 60 + endMinute;

    return currentTimeMinutes >= startTimeMinutes && currentTimeMinutes <= endTimeMinutes;
  } catch (error) {
    console.error('Error checking availability:', error);
    return false;
  }
}

/**
 * Calculates the next check-in time for a team member
 * @param workDays Array of work days
 * @param workHours Object containing start and end hours
 * @param timeZone Time zone of the team member
 * @param frequencyHours How often to check in (in hours)
 * @returns Date object for the next check-in
 */
export function calculateNextCheckIn(
  workDays: string[],
  workHours: { start: string; end: string },
  timeZone: string,
  frequencyHours: number = 24
): Date {
  const now = new Date();

  // Function to get date with specific time in member's timezone
  const getDateWithTime = (date: Date, timeStr: string): Date => {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const result = new Date(date);
    result.setHours(hours, minutes, 0, 0);
    return result;
  };

  // Try to find the next check-in time
  let nextDate = new Date(now);
  let daysChecked = 0;

  while (daysChecked < 14) {
    // Prevent infinite loop, check up to 2 weeks
    // Format the day name in the team member's timezone
    const options: Intl.DateTimeFormatOptions = {
      timeZone,
      weekday: 'long',
    };
    const dayName = new Intl.DateTimeFormat('en-US', options).format(nextDate);

    // Check if this is a workday
    if (workDays.includes(dayName)) {
      // Get start time for this date
      const startTime = getDateWithTime(nextDate, workHours.start);

      // If we're before start time on a workday, schedule at start time
      if (nextDate < startTime) {
        return startTime;
      }

      // Get end time for this date
      const endTime = getDateWithTime(nextDate, workHours.end);

      // If we're within work hours, schedule after frequency hours (but within work hours)
      if (nextDate <= endTime) {
        const nextCheckIn = new Date(nextDate.getTime() + frequencyHours * 60 * 60 * 1000);

        // If next check-in falls within work hours, use it
        if (nextCheckIn <= endTime) {
          return nextCheckIn;
        }

        // Otherwise, go to next work day
      }
    }

    // Move to the next day, at the start of work hours
    nextDate.setDate(nextDate.getDate() + 1);
    nextDate = getDateWithTime(nextDate, workHours.start);
    daysChecked++;
  }

  // Fallback if something goes wrong - return tomorrow
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0); // Default to 9 AM
  return tomorrow;
}

/**
 * Formats a date to a human-readable string
 * @param date Date to format
 * @param timeZone Optional timezone
 * @returns Formatted date string
 */
export function formatDate(date: Date, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  };

  return new Intl.DateTimeFormat('en-US', options).format(date);
}

/**
 * Calculates if a project is on track, at risk, or delayed
 * @param completionPercentage Percentage of completed tasks
 * @param elapsedTimePercentage Percentage of elapsed time
 * @returns Status string
 */
export function getProjectStatus(
  completionPercentage: number,
  elapsedTimePercentage: number
): 'ON_TRACK' | 'AT_RISK' | 'DELAYED' {
  const difference = completionPercentage - elapsedTimePercentage;

  if (difference >= -10) {
    return 'ON_TRACK'; // Within 10% of expected progress
  } else if (difference >= -20) {
    return 'AT_RISK'; // 10-20% behind schedule
  } else {
    return 'DELAYED'; // More than 20% behind schedule
  }
}
