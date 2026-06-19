# Sprint Retrospective Meeting Notes

**Date:** January 15, 2024  
**Time:** 10:00 AM – 11:00 AM  
**Attendees:** Sarah Mitchell, James Chen, Priya Patel, Marcus Johnson, Emily Rivera  
**Facilitator:** James Chen

---

## Agenda

1. Review of last sprint's action items
2. What went well
3. What could be improved
4. Action items for next sprint

---

## Discussion Points

### Code Review Practices
- James raised concerns about turnaround time on pull requests. Average review time last sprint was 2.3 days.
- Team agreed to adopt a 24-hour SLA for initial review feedback.
- Priya suggested using GitHub's auto-assign feature to distribute reviews more evenly.
- **Action:** Marcus to configure auto-assign rules by end of week.

### CI/CD Pipeline Improvements
- Emily reported 3 pipeline failures last sprint due to flaky integration tests.
- The `test_payment_gateway` suite has a 15% flake rate — needs investigation.
- Team discussed adding retry logic for known flaky tests as a short-term fix.
- Long-term plan: refactor integration tests to use mocked external services.
- **Action:** Emily to create tickets for test refactoring (estimated 5 story points).

### Team Velocity
- Last sprint velocity: 34 story points (target was 38).
- Shortfall attributed to unplanned production incident on Jan 10 (4 hours of team time).
- Priya noted that estimation accuracy has improved — 85% of stories completed within original estimates.
- Team agreed to maintain current sprint capacity of 38 points.

### Miscellaneous
- Office snack budget approved — Marcus to coordinate with facilities.
- Team building event scheduled for February 2nd (bowling).
- Reminder: company all-hands on January 22nd at 2 PM.

---

## Action Items

| # | Owner | Description | Due Date |
|---|-------|-------------|----------|
| 1 | Marcus | Configure PR auto-assign rules | Jan 19 |
| 2 | Emily | Create test refactoring tickets | Jan 17 |
| 3 | James | Update sprint board with new velocity targets | Jan 16 |
| 4 | Marcus | Coordinate snack order with facilities | Jan 19 |

---

*Next retrospective: January 29, 2024*
