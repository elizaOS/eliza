# Orchestrator Lifecycle Scenarios

Each scenario JSON file defines:
- `scenario_id`
- `title`
- `category`
- `required_capabilities`
- `turns[]` with `actor`, `message`, `expected_behaviors`, `forbidden_behaviors`

Behavior tags align with the lifecycle evaluator:
- `ask_clarifying_question_before_start`
- `do_not_start_without_required_info`
- `spawn_subagent`
- `report_active_subagent_status`
- `ack_scope_change`
- `apply_scope_change_to_task`
- `pause_task`
- `resume_task`
- `cancel_task`
- `confirm_cancel_effect`
- `final_summary_to_stakeholder`
