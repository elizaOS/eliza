/** Provides a short, time-aware opening that proposes useful work instead of asking the user to invent a task. */

export function anticipatoryGreetingForHour(hour: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError("hour must be an integer from 0 through 23");
  }

  if (hour < 12) return "Good morning. I can start with today's plan.";
  if (hour < 18) {
    return "Good afternoon. I can take the next task off your plate.";
  }
  return "Good evening. I can wrap up today and set up tomorrow.";
}
