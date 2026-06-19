# Weekly Sync — February 6, 2026

**Attendees:** Wang Jun, Zhang Wei, Li Mei, Chen Bo

## Agenda
1. Task progress review
2. Blockers & dependencies
3. Next week priorities

## Notes

### Backend API Migration (Zhang Wei)
- Auth endpoints migrated and passing all tests
- Payment endpoints almost done — finishing edge cases around refund callbacks
- Blocker: Notification service depends on the new RabbitMQ cluster (infra team says Feb 10–11)
- Risk: If MQ setup slips, migration could miss Feb 14 deadline

### Mobile UI Redesign (Li Mei)
- Wireframes approved by product team on Feb 4
- Design system tokens exported to Figma and code
- Starting home screen implementation next week
- Question: Should dark mode be in scope for v1?
  - **Decision:** Include if time permits; defer to phase 2 if tight

### Analytics Dashboard (Chen Bo)
- Data pipeline deployed to staging
- Retention metrics query functional but slow on large ranges
- Will optimize with materialized views this week
- DAU/MAU charts start next week after pipeline stabilizes

## Action Items
- [ ] Zhang Wei: Start notification endpoint migration once MQ is ready
- [ ] Li Mei: Share home screen draft by Feb 8 EOD
- [ ] Chen Bo: Benchmark retention query with 90-day range
- [ ] Wang Jun: Follow up with infra team on MQ timeline
