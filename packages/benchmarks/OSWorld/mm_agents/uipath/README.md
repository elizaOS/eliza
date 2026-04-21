# UiPath Screen Agent

### 23 Dec 2025
- Updated the planner model to [Claude 4.5 Opus](https://www.anthropic.com/news/claude-opus-4-5)
- Updated the grounder model to an internally finetuned version of [Qwen3-VL](https://github.com/QwenLM/Qwen3-VL) and allowing it to predict "refusal" (similar to OSWorld-G) for elements that do not exist 
- Added memory for storing relevant information across steps
- Improved utilization of the UI element detector for fine grained details (such as cell corners)
- Refactoring and various small fixes

### 18 Sep 2025
We propose a simple, yet effective implementation of a Computer Use Agent, which achieves a performance of **53.6%** on the **OSWorld** benchmark with 50 steps, demonstrating competitive results with a relatively lightweight setup and UI only actions. 

Our system builds upon recent approaches in agentic computer use and follows the literature in adopting a two-stage architecture that separates high-level reasoning from low-level execution. Specifically, the system is composed of:

- **Action Planner (GPT-5)**: Responsible for generating high-level action sequences, reasoning about task goals and observing modifications in the environment.
- **Grounder (UI-TARS 1.5 + Internal UI Predictor)**: This component translates abstract plans into concrete interactions with the user interface. The UI-TARS 1.5 serves as the grounding mechanism, mapping planned actions to locations on screen, while the Internal UI Predictor assists in resolving ambiguous predictions, increasing the robustness and probability of the predictions to fall within UI elements.

![Schema](imgs/schema.png)

## Run
```
python run_multienv_uipath.py \
  --provider_name docker \
  --observation_type screenshot \
  --model uipath_gpt_5 \
  --sleep_after_execution 3 \
  --max_steps 50 \
  --num_envs 10 \
  --action_space computer_13 \
  --client_password password \
  --test_all_meta_path evaluation_examples/test_all.json \
  --uipath_model_name gpt-5-2025-08-07
```

## Action Planner
The Action Planner receives the current screenshot, a task description, and a history of previous steps - including past screenshots, observations, internal reasoning, and predicted actions. Its role is to plan the next steps toward achieving the task goal, anticipate changes in the environment, and determine the next action, providing clear reasoning for each decision.

The interaction history is structured as a conversation: the user reports the task, executed actions, supplies recent screenshots (up to the last two), and notes previously predicted outcomes of the agent, while the assistant replies consist of previously predicted agent responses. We adopt this conversational format because it mirrors the dialogue-style data the model was originally trained on, making the setup both natural and effective.

By combining the current state with this structured history, the Action Planner generates context-aware, informed predictions at every step, being able to reconstruct the sequence of actions that led him to this point, noticing eventual failures, and plan the subsequent steps.

We support a concise set of actions for interacting with the environment, focusing specifically on UI-related activities:
- Click (left, right, double, triple, click)
- Type
- Scroll
- Drag
- Mouse move
- Key press
- Extract data – a pseudo-action used to capture information for later steps
- Finish

To help the planner model understand how to effectively apply actions, we provide them through few-shot examples.

We intentionally exclude more complex actions to isolate and evaluate the capabilities of a UI-focused agent, since certain advanced actions may not be applicable across all applications.

## Grounder
The Grounder maps the action to a certain point on the screen, if needed (for actions such as click, scroll, drag). It receives the screenshot, description of action to be performed and the type of the actions and returns a pair of integers representing the screen coordinates.

We utilized the `UI-TARS-1.5` model, which has amazing screen knowledge and capabilities, however, to ensure more confidence in the predicted coordinates, we employ a crop-and-refine method, using an internal UI element predictor.

### Crop and refine
We wrap the prediction of the grounding model with our internal UI element predictor. The goal of this step is not to guarantee that the prediction will always fall within an identified element, but to increase the likelihood of alignment and to give the model an opportunity to refine its output.

The UI element predictor consists of a shared feature extractor backbone and multiple prediction towers for:
- identifying UI elements or controls such as icons, input boxes, checkboxes, buttons, radio buttons
- tables and cells
- few other tasks not used for our approach, but employed in other use-cases and needed in training for improving the feature extractor performance

![Element preditions](imgs/element_predictions.png)

In most interfaces, actions are expected to interact directly with UI elements: buttons, fields, icons, or menus. When a prediction lands outside any element, this often signals a potential misprediction. While there are legitimate cases where a click outside elements makes sense (e.g., dismissing a modal, dragging to select text, or changing window focus), they are exceptions rather than the rule. By treating these situations as possible errors, we can provide the model with a structured way to reconsider its output.

Our approach is to give the model a “second shot” when its initial prediction falls outside an identified element. We do this by cropping around the former prediction and running the prediction again. This retry doesn’t guarantee correctness, but it does give the model a chance to adjust and potentially recover from mistakes. We crop around the original coordinates including close UI elements.

This process gives the model multiple opportunities to predict within a relevant zone of the interface, reducing the overall number of mispredictions. In our experiments, the grounding model placed predictions outside any UI element about 11% of the time. After applying our refinement step, the second prediction was always different from the original, demonstrating that the model does reconsider and “changes its mind” when given this guided feedback.

## Conclusion
Our method offers a clean and simple yet competitive pipeline for Computer Use tasks. It is cost effective, minimizing token usage during planning, avoiding parallel planning and reliance on numerous past images, and incorporate only **direct UI actions** with refined grounding actions to improve accuracy. With this approach, we achieve **53.6%** accuracy on OSWorld with a 50-step horizon.
