## Introduction and Goals of the Verifiers Project
Verifiers is a Python library for large language model (LLM) reinforcement learning and verifiable environments. It supports various RL tasks such as multi-round reasoning, tool invocation, and automatic reward evaluation. The library aims to provide an efficient, flexible, and scalable environment and reward mechanism for the training and evaluation of LLM agents.

## Natural Language Instructions (Prompt)
Please create a Python project named Verifiers to implement a verifiable multi-round LLM RL training and evaluation library. The project should include the following features:
1. **Parser and Message Processing**
    - **Basic Text Parser**: Capable of extracting key information from input strings or conversation messages, supporting direct text, structured XML, and step-by-step reasoning formats (e.g., <think>...</think> tags).
    - **XML Parser**: Supports parsing XML formats with complex structures such as multiple fields, field aliases, and missing fields, and outputs structured objects.
    - **Step-by-step Reasoning Parser**: Supports extracting reasoning content with <think> tags and allows custom extraction functions for multi-step reasoning scenarios.
2. **Reward Functions and Evaluation Mechanisms**
    - **Reward Function Rubric**: Supports the registration, weighted combination, and asynchronous invocation of custom reward functions, enabling flexible scoring of model outputs.
    - **Reward Group RubricGroup**: Supports the aggregation and batch scoring of multiple Rubrics, suitable for multi-dimensional and multi-criteria evaluation scenarios.
3. **Environments and Multi-round Conversations**
    - **Single-turn Environment SingleTurnEnv**: Supports single-turn Q&A, chat/completion formats, asynchronous generation, and state management, suitable for basic RL training and evaluation.
    - **Multi-turn Environment MultiTurnEnv**: Supports multi-round conversations, maximum turn limits, and state management, suitable for complex interactive RL training.
    - **Grouped Environment EnvGroup**: Supports multi-environment grouping, grouped rewards, and batch rollouts, facilitating joint training and evaluation of multi-tasks and multi-scenarios.
4. **Mock Testing and Dataset Support**
    - **MockAsyncOpenAI**: Provides controllable input-output mappings, supporting both chat and completion modes, facilitating unit testing without an API key.
    - **Dataset Support**: Supports the HuggingFace datasets format, facilitating batch data loading and evaluation.
5. **Typical Test Cases and Evaluation Scripts**
    - Provide rich test cases covering all core functions such as parsers, reward functions, single/multi-turn environments, and grouped environments, supporting both asynchronous and synchronous testing methods.
    - Support automated testing and coverage statistics using tools such as pytest, pytest-asyncio, and pytest-cov.
6. **Core File Requirements**: The project must include a complete pyproject.toml file declaring all dependencies (e.g., transformers, datasets, pytest, pytest-asyncio, pytest-cov, openai, deepspeed, etc.), and support one-click installation of all functions using pip install -e .[all]. Provide verifiers/__init__.py as the unified API entry point, exporting core classes such as Parser, XMLParser, ThinkParser, Environment, SingleTurnEnv, MultiTurnEnv, Rubric, RubricGroup, and EnvGroup, allowing users to access all major functions through statements such as from verifiers import Parser, Rubric, SingleTurnEnv. Sub-modules such as verifiers/envs/, verifiers/rubrics/, and verifiers/parsers/ implement functions such as environments, rewards, and parsing respectively, with a clear structure for easy expansion. The tests/ directory should contain test files such as test_parser.py, test_xml_parser.py, test_think_parser.py, test_rubric.py, test_rubric_group.py, test_singleturn_env.py, test_multiturn_env.py, and test_env_group.py, covering all core functional points. Provide mock_openai_client.py containing the MockAsyncOpenAI class, supporting input-output mappings for testing without an API key. All core modules should have clear class/function interfaces, support direct import and use, and provide detailed docstrings explaining input-output formats and data types. Additionally, provide typical use cases and evaluation scripts demonstrating how to use classes such as Parser, Rubric, and SingleTurnEnv for parsing, reward calculation, environment interaction, and evaluation.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.11.13

### Core Dependency Versions
```Plain

#### Main Dependencies (Basic Functions)
- openai
- datasets
- pytest >=8.4.1
- pytest-asyncio >=0.23.8
- pytest-cov >=6.2.1

#### Optional Dependencies [all]
- pre-commit
- setuptools
- pytest >=7.0.0
- pytest-asyncio >=0.21.0
- pytest-cov >=4.0.0
- sphinx
- myst-parser
- sphinx-rtd-theme
- requests
- torch >=2.7.0
- transformers
- accelerate >=1.4.0
- deepspeed
- peft
- wandb
- rich
- trl >=0.17.0
- vllm >=0.9.2
- liger-kernel >=0.5.10
- nest-asyncio >=1.6.0
- ipykernel
- ipywidgets
- math-verify >=0.8.0
- duckduckgo-search
- brave-search
- reasoning-gym
- smolagents >=1.15.0
- textarena
- nltk

#### Development-related [dev]
- ruff
- pre-commit
- setuptools
- requests
- pytest >=7.0.0
- pytest-asyncio >=0.21.0
- pytest-cov >=4.0.0
- sphinx
- myst-parser
- sphinx-rtd-theme

#### Training-related [train]
- torch >=2.7.0
- transformers
- accelerate >=1.4.0
- peft
- wandb
- rich
- trl >=0.17.0
- vllm >=0.9.2
- liger-kernel >=0.5.10
- deepspeed

#### Jupyter-related [jupyter]
- nest-asyncio >=1.6.0
- ipykernel
- ipywidgets

#### Environment-related [envs]
- math-verify ==0.8.0
- requests
- duckduckgo-search
- brave-search
- reasoning-gym
- smolagents >=1.15.0
- textarena
- nltk

#### Documentation-related
- sphinx
- sphinx-rtd-theme
- myst-parser
```

## Verifiers Project Architecture
### Project Directory Structure
```
workspace/
├── .pre-commit-config.yaml
├── .readthedocs.yaml
├── LICENSE
├── MANIFEST.in
├── README.md
├── configs
│   ├── endpoints.py
│   ├── zero3.yaml
├── docs
│   ├── Makefile
│   ├── README.md
│   ├── requirements.txt
│   ├── source
│   │   ├── api_reference.md
│   │   ├── components.md
│   │   ├── conf.py
│   │   ├── development.md
│   │   ├── environments.md
│   │   ├── index.md
│   │   ├── overview.md
│   │   └── training.md
├── environments
│   ├── continuation_quality
│   │   ├── README.md
│   │   ├── continuation_quality.py
│   │   └── pyproject.toml
│   ├── doublecheck
│   │   ├── README.md
│   │   ├── doublecheck.py
│   │   └── pyproject.toml
│   ├── gpqa
│   │   ├── README.md
│   │   ├── gpqa.py
│   │   └── pyproject.toml
│   ├── gsm8k
│   │   ├── README.md
│   │   ├── gsm8k.py
│   │   └── pyproject.toml
│   ├── math_group
│   │   ├── README.md
│   │   ├── math_group.py
│   │   └── pyproject.toml
│   ├── math_python
│   │   ├── README.md
│   │   ├── math_python.py
│   │   └── pyproject.toml
│   ├── mmmu
│   │   ├── README.md
│   │   ├── mmmu.py
│   │   └── pyproject.toml
│   ├── reasoning_gym_env
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   └── reasoning_gym_env.py
│   ├── reverse_text
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   └── reverse_text.py
│   ├── self_reward
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   └── self_reward.py
│   ├── sentence_repeater
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   └── sentence_repeater.py
│   ├── simpleqa
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   └── simpleqa.py
│   ├── smolagents_math_tools
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   └── smolagents_math_tools.py
│   ├── summarize_text
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   └── summarize_text.py
│   ├── tool_test
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   └── tool_test.py
│   ├── toxicity_explanation
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   └── toxicity_explanation.py
│   ├── wiki_search
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   └── wiki_search.py
│   ├── wordle
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   └── wordle.py
│   ├── xlam_function_calling
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   └── xlam_function_calling.py
│   ├── xml_tool_env
│   │   ├── README.md
│   │   ├── pyproject.toml
│   │   └── xml_tool_env.py
├── examples
│   ├── grpo
│   │   ├── train_arc_1d.py
│   │   ├── train_continuation_quality.py
│   │   ├── train_gsm8k.py
│   │   ├── train_math_group.py
│   │   ├── train_math_python.py
│   │   ├── train_reverse_text.py
│   │   ├── train_self_reward.py
│   │   ├── train_sentence_repeater.py
│   │   ├── train_tool_test.py
│   │   ├── train_wiki_search.py
│   │   └── train_wordle.py
│   └── sft.py
├── notes
│   └── RELEASE_v0.1.3.post0.md
├── pyproject.toml
└── verifiers
    ├── __init__.py
    ├── envs
    │   ├── __init__.py
    │   ├── env_group.py
    │   ├── environment.py
    │   ├── multiturn_env.py
    │   ├── singleturn_env.py
    │   ├── stateful_tool_env.py
    │   ├── textarena_env.py
    │   ├── tool_env.py
    ├── inference
    │   ├── __init__.py
    │   ├── vllm_client.py
    │   ├── vllm_server.py
    ├── parsers
    │   ├── __init__.py
    │   ├── parser.py
    │   ├── think_parser.py
    │   ├── xml_parser.py
    ├── rubrics
    │   ├── __init__.py
    │   ├── judge_rubric.py
    │   ├── math_rubric.py
    │   ├── rubric.py
    │   ├── rubric_group.py
    │   ├── tool_rubric.py
    │   ├── utils
    │   │   └── math_utils.py
    ├── scripts
    │   ├── __init__.py
    │   ├── eval.py
    │   ├── init.py
    │   ├── install.py
    │   ├── tui.py
    ├── trainers
    │   ├── __init__.py
    │   ├── async_batch_generator.py
    │   ├── async_dataloader_wrapper.py
    │   ├── grpo_config.py
    │   ├── grpo_trainer.py
    ├── types.py
    └── utils
        ├── __init__.py
        ├── async_utils.py
        ├── data_utils.py
        ├── env_utils.py
        ├── logging_utils.py
        ├── message_utils.py
        ├── model_utils.py
        ├── report_utils.py
        ├── tool_utils.py
        └── tools.py

```


# API Usage Guide

## Core API

### 1. Module Import
```python
from verifiers import (
    Parser, XMLParser, ThinkParser,
    Environment, SingleTurnEnv, MultiTurnEnv,
    Rubric, RubricGroup, EnvGroup
)
from verifiers.envs.env_group import EnvGroupRubric
```

---

### 2. Parser-related

#### Parser Basic Parser
**Function**: Basic text parsing and answer extraction.
**Function Signature**:
```python
class Parser:
    def __init__(self, extract_fn: Callable[[str], str] = lambda x: x)
    def parse(self, text: str) -> Any
    def parse_answer(self, completion: Messages) -> str | None
    def get_format_reward_func(self) -> Callable
    def get_assistant_messages(self, completion: list[ChatMessage]) -> list[ChatMessage]
    def get_system_messages(self, completion: list[ChatMessage]) -> list[ChatMessage]
    def get_user_messages(self, completion: list[ChatMessage]) -> list[ChatMessage]
    def get_tool_messages(self, completion: list[ChatMessage]) -> list[ChatMessage]
```

#### XMLParser
**Function**: Extracting structured XML fields.
**Function Signature**:
```python
class XMLParser(Parser):
    def __init__(
        self,
        fields: list[str | tuple[str, ...]],
        answer_field: str = "answer",
        extract_fn: Callable[[str], str] = lambda x: x,
    ):
```

#### ThinkParser
**Function**: Extracting step-by-step reasoning content.
**Function Signature**:
```python
class ThinkParser(Parser):
    def __init__(self, extract_fn: Callable[[str], str] = lambda x: x)
    def parse(self, text: str) -> str
```

---

### 3. Reward and Evaluation Rubric

#### Rubric
**Function**: Combining multiple reward functions and supporting batch scoring.
**Function Signature**:
```python
class Rubric:
    def __init__(
        self,
        funcs: list[RewardFunc] | None = None,
        weights: list[float] | None = None,
        parser: Parser | None = None,
        parallelize_scoring: bool = True,
        **kwargs
    )
    
    async def score_rollout(
        self,
        prompt: Messages,
        completion: Messages,
        answer: str,
        state: State,
        task: str = "default",
        info: Info | None = None,
        example_id: int | None = None,
        **kwargs,
    ) -> RolloutScore
    
    async def score_rollouts(
        self,
        prompts: list[Messages],
        completions: list[Messages],
        answers: list[str],
        states: list[State],
        tasks: list[str],
        infos: list[Info],
        example_ids: list[int] | None = None,
        max_concurrent: int = -1,
        use_tqdm: bool = True,
        **kwargs,
    ) -> RolloutScores
```

#### RubricGroup
**Function**: Aggregating multiple Rubrics for comprehensive evaluation.
**Function Signature**:
```python
class RubricGroup(Rubric):
    def __init__(self, rubrics: list[Rubric], **kwargs)
    def score_rollouts(
        self,
        prompts: list[Messages],
        completions: list[Messages],
        answers: list[str],
        states: list[State],
        tasks: list[str],
        infos: list[Info],
        example_ids: list[int] | None = None,
        max_concurrent: int = -1,
        use_tqdm: bool = True,
        **kwargs,
        ) -> RolloutScores:
```

---

### 4. Environments and Multi-round Conversations

#### SingleTurnEnv
**Function**: Single-turn Q&A environment supporting chat/completion formats.
**Function Signature**:
```python
class SingleTurnEnv(MultiTurnEnv):
    # Inherits __init__ from MultiTurnEnv
    async def is_completed(self, messages: Messages, state: State, **kwargs) -> bool
    async def env_response(self, messages: Messages, state: State, **kwargs) -> tuple[Messages, State]
```

#### MultiTurnEnv
**Function**: Multi-round conversation environment supporting custom termination conditions and environment responses.
**Function Signature**:
```python
class MultiTurnEnv(Environment):
    def __init__(self, max_turns: int = -1, **kwargs)
    async def is_completed(self, messages: Messages, state: State, **kwargs) -> bool
    
    @abstractmethod
    async def env_response(self, messages: Messages, state: State, **kwargs) -> tuple[Messages, State]
    async def setup_state(self, state: State, **kwargs) -> State
```

#### ToolEnv
**Function**: Multi-round environment supporting tool invocation.
**Function Signature**:
```python
class ToolEnv(MultiTurnEnv):
    def __init__(
        self,
        tools: list[Callable] | None = None,
        max_turns: int = 10,
        error_formatter: Callable[[Exception], str] = lambda e: f"{str(e)}",
        **kwargs
    )
```

#### EnvGroup
**Function**: Multi-environment grouping and batch rollouts.
**Function Signature**:
```python
class EnvGroup(Environment):
    def __init__(self, envs: list[Environment], env_names: list[str] | None = None, **kwargs)
```

---

### 5. Evaluation and Data Generation

#### evaluate
**Function**: Evaluate model on the environment's evaluation dataset.
**Function Signature**:
```python
async def evaluate(
    self,
    client: AsyncOpenAI,
    model: str,
    sampling_args: SamplingArgs | None = None,
    num_examples: int = -1,
    rollouts_per_example: int = 1,
    score_rollouts: bool = True,
    max_concurrent: int = -1,
    max_concurrent_generation: int | None = None,
    max_concurrent_scoring: int | None = None,
    interleave_scoring: bool = True,
    results_path: Path | None = None,
    state_columns: list[str] | None = None,
    save_every: int = -1,
    **kwargs
) -> GenerateOutputs
```

#### generate
**Function**: Generate completions and rewards for given inputs.
**Function Signature**:
```python
async def generate(
    self,
    inputs: GenerateInputs | Dataset | dict,
    client: AsyncOpenAI,
    model: str,
    sampling_args: SamplingArgs | None = None,
    num_examples: int | None = None,
    rollouts_per_example: int | None = None,
    score_rollouts: bool = True,
    max_concurrent: int = -1,
    max_concurrent_generation: int | None = None,
    max_concurrent_scoring: int | None = None,
    semaphore: asyncio.Semaphore | None = None,
    generation_semaphore: asyncio.Semaphore | None = None,
    scoring_semaphore: asyncio.Semaphore | None = None,
    interleave_scoring: bool = True,
    results_path: Path | None = None,
    state_columns: list[str] | None = None,
    save_every: int = -1,
    use_tqdm: bool = True,
    **kwargs
) -> GenerateOutputs
```

#### process_env_results_vllm
**Function**: Process environment results with tokenization for training (alias: `process_env_results`).
**Function Signature**:
```python
def process_env_results_vllm(
    self,
    prompts: list[Messages],
    completions: list[Messages],
    states: list[State],
    rewards: list[float],
    processing_class: "PreTrainedTokenizerBase",
    max_seq_len: int = -1,
    mask_env_responses: bool = False,
    mask_truncated_completions: bool = False,
    zero_truncated_completions: bool = False,
    message_type: MessageType | None = "chat",
) -> ProcessedOutputs
```

---

### 6. Typical Message and Data Formats

#### Chat Format
```python
messages = [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "What is 2+2?"},
    {"role": "assistant", "content": "4"}
]
```

#### Completion Format
```python
completion = "The answer is 4."
```

#### Dataset Format
```python
dataset = Dataset.from_list([
    {"question": "What is 2+2?", "answer": "4"},
    {"question": "What is 3*5?", "answer": "15"},
])
```
#### 7. call_reward_func 
**Function**: Call the reward function to score the model's performance.
**Function Signature**:
```python
async def call_reward_func(
    self,
    func: RewardFunc,
    prompt: Messages,
    completion: Messages,
    answer: str,
    state: State,
    task: str = "default",
    info: Info | None = None,
    example_id: int | None = None,
    **kwargs,
) -> float:
    """
    Invoke `func` with only the required arguments.
    Automatically detects which parameters the reward function accepts
    and passes only those parameters.
    """
```

#### 8. score_rollout
**Function**: Score a single rollout using all reward functions in the rubric.
**Function Signature**:
```python
async def score_rollout(
    self,
    prompt: Messages,
    completion: Messages,
    answer: str,
    state: State,
    task: str = "default",
    info: Info | None = None,
    example_id: int | None = None,
    **kwargs,
) -> RolloutScore:
    """
    Evaluate all reward functions asynchronously for a single rollout.
    Returns a RolloutScore with individual metrics and weighted total reward.
    """
```

#### 9. get_reward_func_names
**Function**: Get the names of all reward functions (available in both `Rubric` and `RubricGroup`).
**Function Signature**:
```python
def get_reward_func_names(self) -> list[str]:
    """
    Returns a list of all reward function names.
    For RubricGroup, aggregates names from all contained rubrics.
    """
```

#### 10. get_reward_funcs
**Function**: Get all reward functions (available in both `Rubric` and `RubricGroup`).
**Function Signature**:
```python
def get_reward_funcs(self) -> list[RewardFunc]:
    """
    Returns a list of all reward functions.
    For RubricGroup, aggregates functions from all contained rubrics.
    """
```

#### 11. get_reward_weights
**Function**: Get the weights of all reward functions (available in both `Rubric` and `RubricGroup`).
**Function Signature**:
```python
def get_reward_weights(self) -> list[float]:
    """
    Returns a list of all reward function weights.
    For RubricGroup, aggregates weights from all contained rubrics.
    """
```

#### 12. add_reward_func
**Function**: Add a reward function to a rubric.
**Function Signature**:
```python
def add_reward_func(self, func: RewardFunc, weight: float = 1.0):
    """
    Add a reward function with an optional weight.
    For RubricGroup, adds to the first rubric in the group.
    """
```




## Detailed Implementation Nodes of Functions


### Node 1: Basic Text Parsing
**Function Description**:
Responsible for basic text parsing and answer extraction, supporting various input formats such as direct strings and conversation messages (chat/completion). Can be used to extract the final answer or key information from LLM outputs.

**Core Mechanism**:
- Directly return the text or the content of the last assistant message.
- Support both string and message list inputs.
- Extract all assistant messages.

**Input-Output Example**:
```python
from verifiers import Parser

parser = Parser()

# Direct text parsing
result = parser.parse("This is a test string")
print(result)  # "This is a test string"

# Multi-round message parsing
completion = [
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi there"},
    {"role": "user", "content": "How are you?"},
    {"role": "assistant", "content": "I'm doing well"}
]
assistant_msgs = parser.get_assistant_messages(completion)
print([msg["content"] for msg in assistant_msgs])  # ["Hi there", "I'm doing well"]

# Answer extraction
result = parser.parse_answer(completion)
print(result)  # "I'm doing well"
```
**Data Types**: str, List[Dict[str, str]]

---

### Node 2: Structured XML Parsing
**Function Description**:
Parse XML structures in LLM outputs, supporting complex scenarios such as multiple fields, field aliases, missing fields, and empty fields, and output structured objects.

**Core Mechanism**:
- Use regular expressions to extract XML tag content.
- Support field aliases and tolerate missing fields.
- Allow customizing the field list.

**Input-Output Example**:
```python
from verifiers import XMLParser

xml_parser = XMLParser(fields=["reasoning", "answer"])

xml_text = """
<reasoning>
Let me think about this problem step by step.
</reasoning>
<answer>
The final answer is 42.
</answer>
"""
result = xml_parser.parse(xml_text)
print(result.reasoning)  # "Let me think about this problem step by step."
print(result.answer)     # "The final answer is 42."

# Missing field
xml_text = "<reasoning>Only reasoning here</reasoning>"
result = xml_parser.parse(xml_text)
print(result.reasoning)  # "Only reasoning here"
print(result.answer)     # None
```
**Data Types**: str, object (with attributes)

---

### Node 3: Step-by-step Reasoning Parsing
**Function Description**:
Designed specifically for step-by-step reasoning formats, automatically extract the final answer after the <think> tag, and support custom extraction functions (e.g., boxed answers).

**Core Mechanism**:
- Use regular expressions to extract <think> tag content.
- Support custom extract_fn.
- Be compatible with ordinary text without <think> tags.

**Input-Output Example**:
```python
from verifiers import ThinkParser

think_parser = ThinkParser()

text = "<think>Let me think...</think>The answer is 42."
result = think_parser.parse(text)
print(result)  # "The answer is 42."

# Custom extraction of boxed answers
import re
extract_fn = lambda s: re.search(r"\\\\boxed\\{([^}]+)\\}", s).group(1) if re.search(r"\\\\boxed\\{([^}]+)\\}", s) else s
think_parser_boxed = ThinkParser(extract_fn=extract_fn)
text = "<think>Reasoning</think>The answer is \\boxed{42}."
result = think_parser_boxed.parse(text)
print(result)  # "42"
```
**Data Types**: str

---

### Node 4: Reward Function Registration and Combination
**Function Description**:
Support the registration, weighted combination, and asynchronous/synchronous invocation of custom reward functions, enabling flexible scoring of model outputs.

**Core Mechanism**:
- Lists of reward functions and weights.
- Support various input parameters.
- Error handling and default values.

**Input-Output Example**:
```python
from verifiers import Rubric

def reward_func1(completion, answer, **kwargs):
    return 1.0 if completion == answer else 0.0

def reward_func2(completion, **kwargs):
    return len(completion) * 0.1

rubric = Rubric(funcs=[reward_func1, reward_func2], weights=[1.0, 0.5])

# Single-round scoring (async)
import asyncio
result = asyncio.run(rubric.score_rollout(
    prompt="test prompt",
    completion="test",
    answer="test",
    state={}
))
print(result)  # RolloutScore(metrics={'reward_func1': 1.0, 'reward_func2': 0.4}, reward=1.2)
```
**Data Types**: float, dict

---

### Node 5: RubricGroup Aggregation
**Function Description**:
Support the aggregation and batch scoring of multiple Rubrics, suitable for multi-dimensional and multi-criteria evaluation scenarios.

**Core Mechanism**:
- Aggregate multiple Rubrics.
- Support batch rollouts.
- Aggregate weights and function names.

**Input-Output Example**:
```python
from verifiers import Rubric, RubricGroup

rubric1 = Rubric(funcs=[lambda c, **k: 1.0], weights=[1.0])
rubric2 = Rubric(funcs=[lambda c, **k: 0.5], weights=[0.8])
group = RubricGroup(rubrics=[rubric1, rubric2])

prompts = ["What is 1+1?"]
completions = ["2"]
answers = ["2"]
states = [{}]
tasks = ["default"]
infos = [{}]

import asyncio
scores = asyncio.run(group.score_rollouts(prompts, completions, answers, states, tasks, infos))
print(scores)  # {'<lambda>': [1.5], 'reward': [1.5]}
```
**Data Types**: float, dict, list

---

### Node 6: SingleTurnEnv
**Function Description**:
Single-turn Q&A environment supporting chat/completion formats, asynchronous generation, and state management, suitable for basic RL training and evaluation.

**Core Mechanism**:
- Support various message formats.
- State management and termination determination.
- Support asynchronous/synchronous rollouts.

**Input-Output Example**:
```python
from verifiers import SingleTurnEnv, Parser, Rubric
from datasets import Dataset

# Create a sample dataset
sample_dataset = Dataset.from_dict({
    "question": ["What is 2+2?", "What is the capital of France?"],
    "answer": ["4", "Paris"]
})

# Initialize environment (without client and model)
env = SingleTurnEnv(
    dataset=sample_dataset,
    system_prompt="You are a helpful assistant.",
    message_type="chat",
    parser=Parser(),
    rubric=Rubric()
)

# Use the environment with client and model in rollout
import asyncio
from openai import AsyncOpenAI

client = AsyncOpenAI(api_key="your-api-key")
completion, state = asyncio.run(env.rollout(
    client=client,
    model="gpt-4",
    prompt=[{"role": "user", "content": "What is 2+2?"}],
    answer="4"
))
print(completion)  # [{'role': 'assistant', 'content': '4'}]
print(state)       # {'responses': [...], 'answer': '4', ...}
```
**Data Types**: list, dict, str

---

### Node 7: MultiTurnEnv
**Function Description**:
Multi-round conversation environment supporting multi-round interactions, maximum turn limits, and state management, suitable for complex interactive RL training.

**Core Mechanism**:
- Multi-round message flow.
- Maximum turn limits and termination determination.
- Integrate environment responses via `env_response` method.
- Custom termination logic via `is_completed` method.

**Input-Output Example**:
```python
from verifiers import MultiTurnEnv, Parser, Rubric
from datasets import Dataset
from openai import AsyncOpenAI

# Note: MultiTurnEnv is abstract - you need to implement is_completed and env_response
class SimpleMultiTurnEnv(MultiTurnEnv):
    async def is_completed(self, messages, state, **kwargs):
        # Complete after max_turns or when assistant says "DONE"
        if await self.max_turns_reached(state):
            return True
        if messages and messages[-1].get("role") == "assistant":
            return "DONE" in str(messages[-1].get("content", ""))
        return False
    
    async def env_response(self, messages, state, **kwargs):
        # Simple environment feedback
        return [{"role": "user", "content": "Continue"}], state

sample_dataset = Dataset.from_dict({
    "question": ["Start a conversation"],
    "answer": ["target_answer"]
})

env = SimpleMultiTurnEnv(
    dataset=sample_dataset,
    max_turns=3,
    parser=Parser(),
    rubric=Rubric()
)

import asyncio
client = AsyncOpenAI(api_key="your-api-key")
completion, state = asyncio.run(env.rollout(
    client=client,
    model="gpt-4",
    prompt=[{"role": "user", "content": "Start conversation"}],
    answer="target_answer"
))
print(completion)  # List of multi-round messages
print(state)       # Contains responses, turn count, etc.
```
**Data Types**: list, dict

---

### Node 8: EnvGroup
**Function Description**:
Multi-environment grouping, grouped rewards, and batch rollouts, facilitating joint training and evaluation of multi-tasks and multi-scenarios.

**Core Mechanism**:
- Route to multiple environments based on task label.
- Task labels and dataset concatenation.
- Aggregate grouped rewards via EnvGroupRubric.

**Input-Output Example**:
```python
from verifiers import EnvGroup, SingleTurnEnv, Rubric, Parser
from datasets import Dataset
from openai import AsyncOpenAI
import asyncio

# Create two separate environments
dataset1 = Dataset.from_dict({
    "question": ["What is 2+2?"],
    "answer": ["4"]
})
dataset2 = Dataset.from_dict({
    "question": ["Write hello world code"],
    "answer": ["print('hello world')"]
})

env1 = SingleTurnEnv(dataset=dataset1, parser=Parser(), rubric=Rubric())
env2 = SingleTurnEnv(dataset=dataset2, parser=Parser(), rubric=Rubric())

# Create environment group
env_group = EnvGroup(envs=[env1, env2], env_names=["math", "code"])

# Route to specific environment by task
client = AsyncOpenAI(api_key="your-api-key")
result, state = asyncio.run(env_group.rollout(
    client=client,
    model="gpt-4",
    prompt=[{"role": "user", "content": "What is 2+2?"}],
    task="math",  # Routes to env1
    answer="4"
))
print(result)  # List of messages
print(state["task"])  # "math"
```
**Data Types**: list, dict

---

### Node 9: Batch Processing and Results
**Function Description**:
Batch rollouts, result processing, and dataset generation. The `process_env_results_vllm` method processes environment results with tokenization for training, while `make_dataset` converts results to HuggingFace Dataset format.

**Core Mechanism**:
- `process_env_results_vllm` (alias: `process_env_results`): Tokenizes prompts and completions for training
- `make_dataset`: Converts GenerateOutputs to HuggingFace Dataset format

**Input-Output Example**:
```python
from verifiers import SingleTurnEnv
from datasets import Dataset
from transformers import AutoTokenizer
import asyncio
from openai import AsyncOpenAI

# Create and use environment
dataset = Dataset.from_dict({
    "question": ["What is 2+2?"],
    "answer": ["4"]
})
env = SingleTurnEnv(dataset=dataset)

# Generate results
client = AsyncOpenAI(api_key="your-api-key")
results = asyncio.run(env.evaluate(
    client=client,
    model="gpt-4",
    num_examples=1,
    rollouts_per_example=1
))

# Process for training (requires tokenizer)
tokenizer = AutoTokenizer.from_pretrained("gpt2")
processed = env.process_env_results_vllm(
    prompts=results.prompt,
    completions=results.completion,
    states=results.state,
    rewards=results.reward,
    processing_class=tokenizer
)
print(processed.keys())  # prompt_ids, prompt_mask, completion_ids, completion_mask, rewards, etc.

# Convert to HF Dataset
dataset = env.make_dataset(results)
print(dataset)  # HuggingFace Dataset object
```
**Data Types**: dict, list, Dataset

---

### Node 10: Mock Testing Tool (MockAsyncOpenAI)
**Function Description**:
The test suite provides a MockAsyncOpenAI client for testing without real API calls. It maps input messages to predefined responses for both chat and completion modes.

**Core Mechanism**:
- `add_chat_response`: Map specific chat messages to responses
- `add_text_response`: Map text prompts to completion responses  
- `set_default_responses`: Set default fallback responses

**Input-Output Example**:
```python
# MockAsyncOpenAI is defined in tests/conftest.py
# Here's how to use it in tests:
import asyncio

class MockAsyncOpenAI:
    def __init__(self):
        self.chat_completions = {}
        self.text_completions = {}
        self.default_chat_response = "This is a test response"
        self.base_url = "http://localhost/v1/"
        # Setup mock structure with AsyncMock
    
    def add_chat_response(self, messages, response, finish_reason="stop", tool_calls=None):
        key = self._messages_to_key(messages)
        self.chat_completions[key] = {
            "content": response,
            "finish_reason": finish_reason,
            "tool_calls": tool_calls
        }

# Usage example
client = MockAsyncOpenAI()
client.add_chat_response(
    messages=[{"role": "user", "content": "What is 2+2?"}],
    response="The answer is 4"
)
response = asyncio.run(client.chat.completions.create(
    model="test-model",
    messages=[{"role": "user", "content": "What is 2+2?"}]
))
print(response.choices[0].message.content)  # "The answer is 4"
```
**Data Types**: str, dict

---

### Node 11: Dataset and Data Loading Support
**Function Description**:
Support the HuggingFace datasets format for batch data loading and evaluation. Environments automatically format datasets with system prompts and few-shot examples, and support dataset concatenation with task labels for environment groups.

**Core Mechanism**:
- `get_dataset`: Get training dataset (optionally shuffled and limited)
- `get_eval_dataset`: Get evaluation dataset  
- `format_dataset`: Automatically add system prompts, few-shot examples, and example IDs
- Dataset concatenation with task labels in EnvGroup

**Input-Output Example**:
```python
from datasets import Dataset
from verifiers import EnvGroup, SingleTurnEnv, Parser, Rubric

# Create individual environments with datasets
dataset1 = Dataset.from_dict({
    "question": ["What is 2+2?", "What is 3+3?"],
    "answer": ["4", "6"]
})
dataset2 = Dataset.from_dict({
    "question": ["Write hello world"],
    "answer": ["print('hello world')"]
})

env1 = SingleTurnEnv(
    dataset=dataset1,
    system_prompt="You are a math tutor.",
    parser=Parser(),
    rubric=Rubric()
)
env2 = SingleTurnEnv(
    dataset=dataset2,
    system_prompt="You are a coding assistant.",
    parser=Parser(),
    rubric=Rubric()
)

# Get formatted dataset from single environment
formatted_ds = env1.get_dataset()
print(formatted_ds.column_names)  # ['question', 'answer', 'example_id', 'prompt']
print(formatted_ds[0]["prompt"])  # [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}]

# EnvGroup automatically concatenates with task labels
env_group = EnvGroup(envs=[env1, env2], env_names=["math", "code"])
combined_dataset = env_group.get_dataset()
print(combined_dataset.column_names)  # Includes 'task' column
print(combined_dataset["task"])  # ["math", "math", "code"]
```
**Data Types**: Dataset, list, dict

---