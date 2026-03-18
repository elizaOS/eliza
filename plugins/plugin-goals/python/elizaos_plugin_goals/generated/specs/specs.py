"""
Auto-generated canonical action/provider/evaluator docs for plugin-goals.
DO NOT EDIT - Generated from prompts/specs/**.
"""

from __future__ import annotations

import json
from typing import TypedDict

class ActionDoc(TypedDict, total=False):
    name: str
    description: str
    similes: list[str]
    parameters: list[object]
    examples: list[list[object]]

class ProviderDoc(TypedDict, total=False):
    name: str
    description: str
    position: int
    dynamic: bool

class EvaluatorDoc(TypedDict, total=False):
    name: str
    description: str
    similes: list[str]
    alwaysRun: bool
    examples: list[object]

_CORE_ACTION_DOCS_JSON = """{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CANCEL_GOAL",
      "description": "Cancels and removes a goal from tracking.",
      "similes": [
        "DELETE_GOAL",
        "REMOVE_GOAL",
        "DROP_GOAL",
        "STOP_TRACKING"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "Alice",
            "content": {
              "text": "Cancel my goal to learn guitar",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Cancelled goal: \\"Learn guitar\\"",
              "actions": [
                "CANCEL_GOAL"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CREATE_GOAL",
      "description": "Creates a new long-term achievable goal for the agent or a user.",
      "similes": [
        "ADD_GOAL",
        "NEW_GOAL",
        "SET_GOAL",
        "TRACK_GOAL"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "I want to set a goal to learn French fluently"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "New goal created: \\"Learn French fluently\\"",
              "actions": [
                "CREATE_GOAL_SUCCESS"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Add a goal for me to run a marathon"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "New goal created: \\"Run a marathon\\"",
              "actions": [
                "CREATE_GOAL_SUCCESS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UPDATE_GOAL",
      "description": "Updates an existing goal's name or description.",
      "similes": [
        "EDIT_GOAL",
        "MODIFY_GOAL",
        "CHANGE_GOAL",
        "RENAME_GOAL"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "Alice",
            "content": {
              "text": "Rename my reading goal to 'Read 30 books this year'",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Updated goal: \\"Read 30 books this year\\"",
              "actions": [
                "UPDATE_GOAL"
              ]
            }
          }
        ],
        [
          {
            "name": "Bob",
            "content": {
              "text": "Change my exercise goal description to include swimming",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Updated goal description.",
              "actions": [
                "UPDATE_GOAL"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CONFIRM_GOAL",
      "description": "Confirms or cancels a pending goal creation after user review.",
      "similes": [
        "CONFIRM_TASK",
        "APPROVE_GOAL",
        "APPROVE_TASK",
        "GOAL_CONFIRM"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "User",
            "content": {
              "text": "Yes, that looks good",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Created task: 'Finish taxes'",
              "actions": [
                "CONFIRM_GOAL_SUCCESS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "COMPLETE_GOAL",
      "description": "Marks a goal as completed/achieved.",
      "similes": [
        "ACHIEVE_GOAL",
        "FINISH_GOAL",
        "CHECK_OFF_GOAL",
        "ACCOMPLISH_GOAL"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "Alice",
            "content": {
              "text": "I've completed my goal of learning French fluently!",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Congratulations! User goal achieved: \\"Learn French fluently\\"!",
              "actions": [
                "COMPLETE_GOAL"
              ]
            }
          }
        ],
        [
          {
            "name": "Bob",
            "content": {
              "text": "I finally achieved my marathon goal!",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Congratulations! User goal achieved: \\"Run a marathon\\"!",
              "actions": [
                "COMPLETE_GOAL"
              ]
            }
          }
        ]
      ]
    }
  ]
}"""
_ALL_ACTION_DOCS_JSON = """{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CANCEL_GOAL",
      "description": "Cancels and removes a goal from tracking.",
      "similes": [
        "DELETE_GOAL",
        "REMOVE_GOAL",
        "DROP_GOAL",
        "STOP_TRACKING"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "Alice",
            "content": {
              "text": "Cancel my goal to learn guitar",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Cancelled goal: \\"Learn guitar\\"",
              "actions": [
                "CANCEL_GOAL"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CREATE_GOAL",
      "description": "Creates a new long-term achievable goal for the agent or a user.",
      "similes": [
        "ADD_GOAL",
        "NEW_GOAL",
        "SET_GOAL",
        "TRACK_GOAL"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "I want to set a goal to learn French fluently"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "New goal created: \\"Learn French fluently\\"",
              "actions": [
                "CREATE_GOAL_SUCCESS"
              ]
            }
          }
        ],
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Add a goal for me to run a marathon"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "New goal created: \\"Run a marathon\\"",
              "actions": [
                "CREATE_GOAL_SUCCESS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "UPDATE_GOAL",
      "description": "Updates an existing goal's name or description.",
      "similes": [
        "EDIT_GOAL",
        "MODIFY_GOAL",
        "CHANGE_GOAL",
        "RENAME_GOAL"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "Alice",
            "content": {
              "text": "Rename my reading goal to 'Read 30 books this year'",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Updated goal: \\"Read 30 books this year\\"",
              "actions": [
                "UPDATE_GOAL"
              ]
            }
          }
        ],
        [
          {
            "name": "Bob",
            "content": {
              "text": "Change my exercise goal description to include swimming",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Updated goal description.",
              "actions": [
                "UPDATE_GOAL"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CONFIRM_GOAL",
      "description": "Confirms or cancels a pending goal creation after user review.",
      "similes": [
        "CONFIRM_TASK",
        "APPROVE_GOAL",
        "APPROVE_TASK",
        "GOAL_CONFIRM"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "User",
            "content": {
              "text": "Yes, that looks good",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Created task: 'Finish taxes'",
              "actions": [
                "CONFIRM_GOAL_SUCCESS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "COMPLETE_GOAL",
      "description": "Marks a goal as completed/achieved.",
      "similes": [
        "ACHIEVE_GOAL",
        "FINISH_GOAL",
        "CHECK_OFF_GOAL",
        "ACCOMPLISH_GOAL"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "Alice",
            "content": {
              "text": "I've completed my goal of learning French fluently!",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Congratulations! User goal achieved: \\"Learn French fluently\\"!",
              "actions": [
                "COMPLETE_GOAL"
              ]
            }
          }
        ],
        [
          {
            "name": "Bob",
            "content": {
              "text": "I finally achieved my marathon goal!",
              "source": "user"
            }
          },
          {
            "name": "Agent",
            "content": {
              "text": "Congratulations! User goal achieved: \\"Run a marathon\\"!",
              "actions": [
                "COMPLETE_GOAL"
              ]
            }
          }
        ]
      ]
    }
  ]
}"""
_CORE_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "GOALS",
      "description": "Provides information about active goals and recent achievements",
      "dynamic": true
    }
  ]
}"""
_ALL_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "GOALS",
      "description": "Provides information about active goals and recent achievements",
      "dynamic": true
    }
  ]
}"""
_CORE_EVALUATOR_DOCS_JSON = """{
  "version": "1.0.0",
  "evaluators": []
}"""
_ALL_EVALUATOR_DOCS_JSON = """{
  "version": "1.0.0",
  "evaluators": []
}"""

core_action_docs: dict[str, object] = json.loads(_CORE_ACTION_DOCS_JSON)
all_action_docs: dict[str, object] = json.loads(_ALL_ACTION_DOCS_JSON)
core_provider_docs: dict[str, object] = json.loads(_CORE_PROVIDER_DOCS_JSON)
all_provider_docs: dict[str, object] = json.loads(_ALL_PROVIDER_DOCS_JSON)
core_evaluator_docs: dict[str, object] = json.loads(_CORE_EVALUATOR_DOCS_JSON)
all_evaluator_docs: dict[str, object] = json.loads(_ALL_EVALUATOR_DOCS_JSON)

__all__ = [
    "ActionDoc",
    "ProviderDoc",
    "EvaluatorDoc",
    "core_action_docs",
    "all_action_docs",
    "core_provider_docs",
    "all_provider_docs",
    "core_evaluator_docs",
    "all_evaluator_docs",
]
