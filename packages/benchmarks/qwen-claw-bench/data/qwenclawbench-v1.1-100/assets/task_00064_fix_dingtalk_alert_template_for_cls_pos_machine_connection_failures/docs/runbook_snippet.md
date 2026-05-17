# On-call snippet — DingTalk CLS templates (draft)

Some on-call runbooks suggest **dropping the trigger expression from the DingTalk `text` body** to keep messages shorter, on the theory that operators only care about device rows. That guidance predates the current incident review process: triage now expects the **policy condition string** to appear next to the console detail link so people can tell *why* the rule fired without opening CLS.

This file is **not** authoritative for template structure — use `config/cls_template_variables.md`, `config/dingtalk_api_spec.md`, and the alarm inventory spreadsheet instead.
