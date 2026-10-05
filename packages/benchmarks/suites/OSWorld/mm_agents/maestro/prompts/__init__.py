from .registry import (
	prompt_registry,
	get_prompt,
	register_prompt,
	list_prompts,
	list_prompts_by_prefix,
	refresh_prompts,
	module,
)

__all__ = [
	"prompt_registry",
	"get_prompt",
	"register_prompt",
	"list_prompts",
	"list_prompts_by_prefix",
	"refresh_prompts",
	"module",
] 

"""
from gui_agents.prompts import module
text = module.evaluator.final_check_role
text2 = module.manager.planner_role
text3 = module.system_architecture

from gui_agents.prompts import module, refresh_prompts
print(len(module.evaluator.final_check_role))  # 0 now

# After you fill prompts/module/evaluator/final_check_role.txt ...
refresh_prompts()
print(len(module.evaluator.final_check_role))  # now > 0

"""