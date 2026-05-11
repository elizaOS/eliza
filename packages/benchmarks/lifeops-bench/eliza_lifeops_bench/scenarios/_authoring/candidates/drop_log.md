
## 2026-05-10T11:25:08.633967+00:00 static/calendar
- calendar.search_budget_events: validate: ground_truth_actions[0].kwargs.calendarId=parameter 'calendarId' is not declared on action 'CALENDAR'

## 2026-05-10T11:30:30.562315+00:00 static/mail
- mail.forward_invoice_to_accounting: validate: ground_truth_actions[0].kwargs.to=value type does not match declared 'array'
- mail.send_followup_to_client: validate: ground_truth_actions[0].kwargs.to=value type does not match declared 'array'
- mail.forward_to_team_chat: validate: ground_truth_actions[0].kwargs.to=value type does not match declared 'array'
- mail.draft_event_invite: validate: ground_truth_actions[0].kwargs.to=value type does not match declared 'array'
- mail.send_monthly_report_to_manager: validate: ground_truth_actions[0].kwargs.to=value type does not match declared 'array'
- mail.forward_to_external_partner: validate: ground_truth_actions[0].kwargs.to=value type does not match declared 'array'
- mail.draft_feedback_request: validate: ground_truth_actions[0].kwargs.to=value type does not match declared 'array'
- mail.delete_spam_email: conformance: PerfectAgent score=0.500 terminated=respond
- mail.archive_old_promotions: conformance: PerfectAgent score=0.500 terminated=respond
- mail.delete_old_meeting_invite: conformance: PerfectAgent score=0.500 terminated=respond
- mail.archive_all_spam: conformance: PerfectAgent score=0.500 terminated=respond
- mail.delete_duplicate_promotions: conformance: PerfectAgent score=0.500 terminated=respond

## 2026-05-10T11:30:40.515240+00:00 static/messages
- messages.list_recent_imessage_threads: validate: ground_truth_actions[0].kwargs.operation=id 'list_channels' not present in snapshot store 'reminder_list'
- messages.list_all_signal_channels: validate: ground_truth_actions[0].kwargs.operation=id 'list_channels' not present in snapshot store 'reminder_list'
- messages.list_recent_signal_threads_limit: validate: ground_truth_actions[0].kwargs.operation=id 'list_channels' not present in snapshot store 'reminder_list'
- messages.list_recent_telegram_channels: validate: ground_truth_actions[0].kwargs.operation=id 'list_channels' not present in snapshot store 'reminder_list'
- messages.send_whatsapp_to_contact_confirm: duplicate id
- messages.send_gmail_to_contact: conformance: runner exception: KeyError('MESSAGE/send (gmail) requires to_emails')

## 2026-05-10T11:30:50.407347+00:00 static/contacts
- contacts.update_relationship_tag: conformance: PerfectAgent score=0.500 terminated=respond
- contacts.update_notes_for_contact_00006: conformance: PerfectAgent score=0.500 terminated=respond
- contacts.update_notes_for_contact_00011: conformance: PerfectAgent score=0.500 terminated=respond

## 2026-05-10T11:31:04.985768+00:00 static/finance
- finance.grocery_spending_last_30: validate: ground_truth_actions[0].kwargs.subaction=id 'list_transactions' not present in snapshot store 'reminder_list'
- finance.uber_charges_last_90: validate: ground_truth_actions[0].kwargs.subaction=id 'list_transactions' not present in snapshot store 'reminder_list'
- finance.account_txn_list: validate: ground_truth_actions[0].kwargs.subaction=id 'list_transactions' not present in snapshot store 'reminder_list'
- finance.list_airline_charges_last_60: validate: ground_truth_actions[0].kwargs.subaction=id 'list_transactions' not present in snapshot store 'reminder_list'
- finance.list_dining_out_transactions: validate: ground_truth_actions[0].kwargs.subaction=id 'list_transactions' not present in snapshot store 'reminder_list'
- finance.list_gas_station_transactions: validate: ground_truth_actions[0].kwargs.subaction=id 'list_transactions' not present in snapshot store 'reminder_list'
- finance.list_online_shopping_transactions: validate: ground_truth_actions[0].kwargs.subaction=id 'list_transactions' not present in snapshot store 'reminder_list'
- finance.get_recent_refunds: validate: ground_truth_actions[0].kwargs.subaction=id 'list_transactions' not present in snapshot store 'reminder_list'
- finance.list_credit_card_fees: validate: ground_truth_actions[0].kwargs.subaction=id 'list_transactions' not present in snapshot store 'reminder_list'
- finance.list_cash_withdrawals: validate: ground_truth_actions[0].kwargs.subaction=id 'list_transactions' not present in snapshot store 'reminder_list'
- finance.list_education_expenses: validate: ground_truth_actions[0].kwargs.subaction=id 'list_transactions' not present in snapshot store 'reminder_list'
- finance.check_large_transactions_over_500: validate: ground_truth_actions[0].kwargs.subaction=id 'list_transactions' not present in snapshot store 'reminder_list'
- finance.cancel_hulu_subscription: conformance: runner exception: KeyError("MONEY_SUBSCRIPTION_CANCEL: no subscription matched name='Hulu' slug='hulu' (have ['sub_000', 'sub_001', 'sub_002', 'sub_003', 'sub_004', 'sub_005', 'sub_006', 'sub_007'])")

## 2026-05-10T11:31:13.880710+00:00 static/travel
- travel.search_multi_city_flights: validate: ground_truth_actions[0].kwargs.returnDate=value type does not match declared 'string'; ground_truth_actions[1].kwargs.returnDate=value type does not match declared 'string'
- travel.book_flight_business_class: validate: ground_truth_actions[0].kwargs.returnDate=value type does not match declared 'string'; ground_truth_actions[0].kwargs.cabinClass=parameter 'cabinClass' is not declared on action 'BOOK_TRAVEL'
- travel.search_flights_with_multiple_passengers: validate: ground_truth_actions[0].kwargs.returnDate=value type does not match declared 'string'
- travel.search_flights_with_preferred_airline: validate: ground_truth_actions[0].kwargs.returnDate=value type does not match declared 'string'; ground_truth_actions[0].kwargs.preferredAirline=parameter 'preferredAirline' is not declared on action 'BOOK_TRAVEL'
- travel.send_flight_confirmation_email: conformance: runner exception: KeyError('MESSAGE/send (gmail) requires to_emails')
- travel.send_itinerary_via_email: conformance: runner exception: KeyError('MESSAGE/send (gmail) requires to_emails')

## 2026-05-10T11:31:22.292918+00:00 static/health
- health.sleep_last_night: conformance: PerfectAgent score=0.500 terminated=respond
- health.log_blood_pressure: conformance: runner exception: KeyError("LIFE_CREATE/create/health_metric missing required field 'value' in kwargs=['diastolic', 'kind', 'metric', 'occurredAtIso', 'systolic']")

## 2026-05-10T11:31:29.629683+00:00 static/sleep
- sleep.create_sleep_quality_metric: validate: ground_truth_actions[0].kwargs.range=parameter 'range' is not declared on action 'HEALTH'
- sleep.update_sleep_quality_range: validate: ground_truth_actions[0].kwargs.range=parameter 'range' is not declared on action 'HEALTH'
- sleep.delete_winddown_task: validate: ground_truth_actions[0].name=action name 'SCHEDULED_TASK_DELETE' not present in actions.manifest.json
- sleep.create_sleep_summary_report: validate: ground_truth_actions[0].kwargs.qualityMetric=parameter 'qualityMetric' is not declared on action 'HEALTH'; ground_truth_actions[0].kwargs.periodDays=parameter 'periodDays' is not declared on action 'HEALTH'; ground_truth_actions[0].kwargs.deliveryMethod=parameter 'deliveryMethod' is not declared on action 'HEALTH'
- sleep.last_week_sleep_summary: duplicate id
- sleep.snooze_bedtime_15min: conformance: runner exception: KeyError("LIFE_SNOOZE/snooze missing required field 'target' in kwargs=['kind', 'minutes', 'subaction', 'title']")

## 2026-05-10T11:31:40.195702+00:00 static/focus
- focus.list_current_blocks: validate: ground_truth_actions[0].kwargs.subaction=id 'list_active' not present in snapshot store 'reminder_list'

## 2026-05-10T11:31:57.492866+00:00 static/calendar
- calendar.reschedule_one_on_one_to_afternoon: validate: ground_truth_actions[0].kwargs.details.eventId=id 'event_00120' not present in snapshot store 'calendar_event'
- calendar.delete_event_annual_review: validate: ground_truth_actions[0].kwargs.details.eventId=id 'event_00130' not present in snapshot store 'calendar_event'
- calendar.update_title_project_kickoff: conformance: runner exception: KeyError("CALENDAR/update_event missing required field 'start' in kwargs=['calendarId', 'eventId', 'title']")

## 2026-05-10T11:33:10.179838+00:00 live/travel
- live.travel.coordinate_travel_with_visa_deadline: validate: persona_id=must be one of ['alex_eng', 'dev_freelancer', 'kai_student', 'lin_ops', 'maya_parent', 'nora_consultant', 'owen_retiree', 'ria_pm', 'sam_founder', 'tara_night'], got 'nora_consultent'
