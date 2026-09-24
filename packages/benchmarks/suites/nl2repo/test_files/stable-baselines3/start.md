## Introduction and Goals of the Stable-Baselines3 Project

Stable-Baselines3 is a **reinforcement learning algorithm library based on PyTorch**, providing implementations of various state-of-the-art reinforcement learning algorithms. This library is the successor to Stable-Baselines, completely rewritten to support PyTorch instead of TensorFlow, and offers better code organization, a clearer API, and more comprehensive documentation. Its core features include: implementing multiple reinforcement learning algorithms (PPO, A2C, DQN, SAC, TD3, DDPG, etc.), a **unified training and evaluation interface** (supporting vectorized environments, callback functions, model saving and loading), and full support for custom environments and policies. In short, Stable-Baselines3 is committed to providing an easy-to-use, feature-complete, and high-performance reinforcement learning toolkit for quickly implementing and deploying reinforcement learning solutions (e.g., training via `model.learn()`, inference via `model.predict()`, and model management via `model.save()` and `model.load()`).

## Natural Language Instruction (Prompt)

Please create a Python project named Stable-Baselines3 to implement a complete reinforcement learning algorithm library. The project should include the following features:

1. **Algorithm Implementation Module**: Be able to implement multiple reinforcement learning algorithms, including policy gradient methods (PPO, A2C), value function methods (DQN), actor-critic methods (SAC, TD3, DDPG), etc. Each algorithm should include complete training logic, network architecture definition, and hyperparameter configuration.

2. **Standardization of Environment Interfaces**: Implement seamless integration with Gymnasium environments, support vectorized environments to improve training efficiency, including DummyVecEnv, SubprocVecEnv, etc., and support environment wrappers such as Monitor, VecNormalize, etc.

3. **Model Management Functions**: Provide complete model saving, loading, and parameter management functions, support model checkpoints, parameter extraction and setting, and cross-platform compatibility.

4. **Training Process Control**: Implement a callback function system, support training progress monitoring, model saving, early stopping, evaluation, etc., and provide flexible configuration options.

5. **Data Processing and Buffers**: Implement various experience replay buffers (ReplayBuffer, HerReplayBuffer, etc.), support prioritized experience replay, HER (Hindsight Experience Replay), and other technologies.

6. **Evaluation and Testing Tools**: Provide tools for model evaluation, deterministic testing, environment checkers, etc., to ensure the reliability and reproducibility of training results.

7. **Core File Requirements**: The project must include complete pyproject.toml and pyproject.toml files to configure the project as an installable package, declare a complete list of dependencies (including torch, gymnasium, numpy, pandas, matplotlib, tensorboard, etc.), provide stable_baselines3/__init__.py as a unified API entry, import core classes from each algorithm module, so that users can access all major functions through a simple "from stable_baselines3 import PPO, SAC, DQN" statement. In the stable_baselines3/common/base_class.py file, there should be save and load functions for serializing and deserializing models to support cross-device and breakpoint-continued training. In the stable_baselines3/common/utils.py file, there should be a set_random_seed function for setting the random seeds of numpy, random, torch, and the environment to ensure reproducibility and be verified by test_set_random_seed in tests/test_utils.py. In the stable_baselines3/common/env_checker.py file, there should be a check_env function for verifying whether a custom environment meets the Gymnasium interface and be covered by test_check_env_* series of test cases in tests/test_env_checker.py for common errors. In the stable_baselines3/common/env_util.py file, there should be a make_vec_env function for quickly creating DummyVecEnv/SubprocVecEnv and be verified by test_make_vec_env in tests/test_env_util.py for parallel and wrapping behaviors. In the stable_baselines3/common/buffers.py file, there should be a ReplayBuffer.sample function for returning training batches and be verified by test_replaybuffer_sample in tests/test_buffers.py for sampling shapes and types. In the stable_baselines3/her/her_replay_buffer.py file, there should be a HerReplayBuffer.sample_transitions function for implementing HER goal resampling and be verified by test_her_relabeling in tests/test_her.py for relabeling logic. In the stable_baselines3/common/evaluation.py file, there should be an evaluate_policy function for统计平均奖励 and standard deviation over multiple episodes and be verified by test_evaluate_policy in tests/test_evaluation.py for statistical result ranges. In the stable_baselines3/common/torch_layers.py file, there should be create_mlp and BaseFeaturesExtractor for building policy networks and be verified by test_create_mlp_output_shape in tests/test_torch_layers.py for output dimensions. In the stable_baselines3/common/logger.py file, there should be configure and Logger.record/dump functions for configuring log output and be verified by test_logger_records_and_dumps in tests/test_logger.py for file and TensorBoard output. In the stable_baselines3/common/save_util.py file, there should be save_to_pkl and load_from_pkl for persisting non-model objects and be verified by test_pkl_roundtrip in tests/test_save_util.py for serialization consistency.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.12.4

### Core Dependency Library Versions

```Plain
# Deep learning framework
torch>=1.13.0                    # PyTorch deep learning framework
torchvision>=0.14.0              # PyTorch computer vision library

# Reinforcement learning environment
gymnasium>=0.28.1                # Standard interface for reinforcement learning environments
gymnasium[atari]>=0.28.1         # Support for Atari game environments
gymnasium[box2d]>=0.28.1         # Support for Box2D physics environments
gymnasium[mujoco]>=0.28.1        # Support for MuJoCo physics environments

# Numerical computation library
numpy>=1.21.0                    # Basic numerical computation library
scipy>=1.7.0                     # Scientific computation library

# Data processing and visualization
pandas>=1.3.0                    # Data processing and analysis
matplotlib>=3.5.0                # Data visualization
seaborn>=0.11.0                  # Statistical visualization

# Logging and monitoring
tensorboard>=2.10.0              # Training logging and visualization
wandb>=0.13.0                    # Experiment tracking (optional)

# Testing framework
pytest>=6.0.0                    # Unit testing framework
pytest-cov>=3.0.0                # Test coverage

# Development and building tools
wheel>=0.37.0                    # Package distribution format
```

### System Requirements

```Plain
# Python version requirements
Python >= 3.9                    # Minimum Python version

# Operating system support
Linux (Ubuntu 18.04+)            # Mainly supported platform
macOS (10.15+)                   # Supported platform
Windows (10+)                    # Supported platform

# GPU support (optional)
CUDA >= 11.0                     # NVIDIA GPU support
cuDNN >= 8.0                     # Deep learning acceleration library
```

## Stable-Baselines3 Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .dockerignore
├── .gitignore
├── .readthedocs.yml
├── CITATION.bib
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── Dockerfile
├── LICENSE
├── Makefile
├── NOTICE
├── README.md
├── scripts
│   ├── build_docker.sh
│   ├── run_docker_cpu.sh
│   ├── run_docker_gpu.sh
│   ├── run_tests.sh
├── stable_baselines3
│   ├── __init__.py
│   ├── a2c
│   │   ├── __init__.py
│   │   ├── a2c.py
│   │   ├── policies.py
│   ├── common
│   │   ├── __init__.py
│   │   ├── atari_wrappers.py
│   │   ├── base_class.py
│   │   ├── buffers.py
│   │   ├── callbacks.py
│   │   ├── distributions.py
│   │   ├── env_checker.py
│   │   ├── env_util.py
│   │   ├── envs
│   │   │   ├── __init__.py
│   │   │   ├── bit_flipping_env.py
│   │   │   ├── identity_env.py
│   │   │   ├── multi_input_envs.py
│   │   ├── evaluation.py
│   │   ├── logger.py
│   │   ├── monitor.py
│   │   ├── noise.py
│   │   ├── off_policy_algorithm.py
│   │   ├── on_policy_algorithm.py
│   │   ├── policies.py
│   │   ├── preprocessing.py
│   │   ├── results_plotter.py
│   │   ├── running_mean_std.py
│   │   ├── save_util.py
│   │   ├── sb2_compat
│   │   │   ├── __init__.py
│   │   │   ├── rmsprop_tf_like.py
│   │   ├── torch_layers.py
│   │   ├── type_aliases.py
│   │   ├── utils.py
│   │   ├── vec_env
│   │   │   ├── __init__.py
│   │   │   ├── base_vec_env.py
│   │   │   ├── dummy_vec_env.py
│   │   │   ├── patch_gym.py
│   │   │   ├── stacked_observations.py
│   │   │   ├── subproc_vec_env.py
│   │   │   ├── util.py
│   │   │   ├── vec_check_nan.py
│   │   │   ├── vec_extract_dict_obs.py
│   │   │   ├── vec_frame_stack.py
│   │   │   ├── vec_monitor.py
│   │   │   ├── vec_normalize.py
│   │   │   ├── vec_transpose.py
│   │   │   └── vec_video_recorder.py
│   ├── ddpg
│   │   ├── __init__.py
│   │   ├── ddpg.py
│   │   ├── policies.py
│   ├── dqn
│   │   ├── __init__.py
│   │   ├── dqn.py
│   │   ├── policies.py
│   ├── her
│   │   ├── __init__.py
│   │   ├── goal_selection_strategy.py
│   │   ├── her_replay_buffer.py
│   ├── ppo
│   │   ├── __init__.py
│   │   ├── policies.py
│   │   ├── ppo.py
│   ├── py.typed
│   ├── sac
│   │   ├── __init__.py
│   │   ├── policies.py
│   │   ├── sac.py
│   ├── td3
│   │   ├── __init__.py
│   │   ├── policies.py
│   │   ├── td3.py
│   ├── version.txt
└── pyproject.toml

```

## API Usage Guide
### Core API
####  Module Import

```python
from stable_baselines3 import (
    PPO, A2C, DQN, SAC, TD3, DDPG,
    HerReplayBuffer, ReplayBuffer,
    VecNormalize, VecMonitor, DummyVecEnv, SubprocVecEnv,
    CheckpointCallback, EvalCallback, StopTrainingOnRewardThreshold
)
# workspace\stable_baselines3\common\policies.py
from stable_baselines3.common.distributions import (
    BernoulliDistribution,
    CategoricalDistribution,
    DiagGaussianDistribution,
    Distribution,
    MultiCategoricalDistribution,
    StateDependentNoiseDistribution,
    make_proba_distribution,
)
from stable_baselines3.common.preprocessing import get_action_dim, is_image_space, maybe_transpose, preprocess_obs
from stable_baselines3.common.torch_layers import (
    BaseFeaturesExtractor,
    CombinedExtractor,
    FlattenExtractor,
    MlpExtractor,
    NatureCNN,
    create_mlp,
)
from stable_baselines3.common.type_aliases import PyTorchObs, Schedule
from stable_baselines3.common.utils import get_device, is_vectorized_observation, obs_as_tensor

# workspace\stable_baselines3\common\base_class.py
from stable_baselines3.common import utils
from stable_baselines3.common.callbacks import BaseCallback, CallbackList, ConvertCallback, ProgressBarCallback
from stable_baselines3.common.env_util import is_wrapped
from stable_baselines3.common.logger import Logger
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.noise import ActionNoise
from stable_baselines3.common.policies import BasePolicy
from stable_baselines3.common.preprocessing import check_for_nested_spaces, is_image_space, is_image_space_channels_first
from stable_baselines3.common.save_util import load_from_zip_file, recursive_getattr, recursive_setattr, save_to_zip_file
from stable_baselines3.common.type_aliases import GymEnv, MaybeCallback, Schedule, TensorDict
from stable_baselines3.common.utils import (
    FloatSchedule,
    check_for_correct_spaces,
    get_device,
    get_system_info,
    set_random_seed,
    update_learning_rate,
)
from stable_baselines3.common.vec_env import (
    DummyVecEnv,
    VecEnv,
    VecNormalize,
    VecTransposeImage,
    is_vecenv_wrapped,
    unwrap_vec_normalize,
)
from stable_baselines3.common.vec_env.patch_gym import _convert_space, _patch_env

# workspace\stable_baselines3\common\buffers.py
from stable_baselines3.common.preprocessing import get_action_dim, get_obs_shape
from stable_baselines3.common.type_aliases import (
    DictReplayBufferSamples,
    DictRolloutBufferSamples,
    ReplayBufferSamples,
    RolloutBufferSamples,
)
from stable_baselines3.common.utils import get_device
from stable_baselines3.common.vec_env import VecNormalize

# workspace\stable_baselines3\common\callbacks.py
from stable_baselines3.common.logger import Logger
from stable_baselines3.common.evaluation import evaluate_policy
from stable_baselines3.common.vec_env import DummyVecEnv, VecEnv, sync_envs_normalization

# workspace\stable_baselines3\common\distributions.py
from torch.distributions import Bernoulli, Categorical, Normal
from stable_baselines3.common.preprocessing import get_action_dim

# workspace\stable_baselines3\common\env_checkr.py
from stable_baselines3.common.preprocessing import check_for_nested_spaces, is_image_space_channels_first
from stable_baselines3.common.vec_env import DummyVecEnv, VecCheckNan

# workspace\stable_baselines3\common\on_policy_algorithm.py
from stable_baselines3.common.base_class import BaseAlgorithm
from stable_baselines3.common.buffers import DictRolloutBuffer, RolloutBuffer
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.policies import ActorCriticPolicy
from stable_baselines3.common.type_aliases import GymEnv, MaybeCallback, Schedule
from stable_baselines3.common.utils import obs_as_tensor, safe_mean
from stable_baselines3.common.vec_env import VecEnv

# workspace\stable_baselines3\common\off_policy_algorithm.py
from stable_baselines3.common.base_class import BaseAlgorithm
from stable_baselines3.common.buffers import DictReplayBuffer, NStepReplayBuffer, ReplayBuffer
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.noise import ActionNoise, VectorizedActionNoise
from stable_baselines3.common.policies import BasePolicy
from stable_baselines3.common.save_util import load_from_pkl, save_to_pkl
from stable_baselines3.common.type_aliases import GymEnv, MaybeCallback, RolloutReturn, Schedule, TrainFreq, TrainFrequencyUnit
from stable_baselines3.common.utils import safe_mean, should_collect_more_steps
from stable_baselines3.common.vec_env import VecEnv
from stable_baselines3.her.her_replay_buffer import HerReplayBuffer

# workspace\stable_baselines3\vec_env\__init__.py
from stable_baselines3.common.vec_env.base_vec_env import CloudpickleWrapper, VecEnv, VecEnvWrapper
from stable_baselines3.common.vec_env.dummy_vec_env import DummyVecEnv
from stable_baselines3.common.vec_env.stacked_observations import StackedObservations
from stable_baselines3.common.vec_env.subproc_vec_env import SubprocVecEnv
from stable_baselines3.common.vec_env.vec_check_nan import VecCheckNan
from stable_baselines3.common.vec_env.vec_extract_dict_obs import VecExtractDictObs
from stable_baselines3.common.vec_env.vec_frame_stack import VecFrameStack
from stable_baselines3.common.vec_env.vec_monitor import VecMonitor
from stable_baselines3.common.vec_env.vec_normalize import VecNormalize
from stable_baselines3.common.vec_env.vec_transpose import VecTransposeImage
from stable_baselines3.common.vec_env.vec_video_recorder import VecVideoRecorder

# workspace\stable_baselines3\envs\__init__.py
from stable_baselines3.common.envs.bit_flipping_env import BitFlippingEnv
from stable_baselines3.common.envs.identity_env import (
    FakeImageEnv,
    IdentityEnv,
    IdentityEnvBox,
    IdentityEnvMultiBinary,
    IdentityEnvMultiDiscrete,
)
from stable_baselines3.common.envs.multi_input_envs import SimpleMultiObsEnv

```

#### 1. `A2C` Class - Advantage Actor Critic Algorithm

**Function**: Implements the Advantage Actor Critic (A2C) reinforcement learning algorithm for training policies in various environment spaces.

**Class Definition**:
```python
class A2C(OnPolicyAlgorithm):
    policy_aliases: ClassVar[dict[str, type[BasePolicy]]] = {
        "MlpPolicy": ActorCriticPolicy,
        "CnnPolicy": ActorCriticCnnPolicy,
        "MultiInputPolicy": MultiInputActorCriticPolicy,
    }

    def __init__(
        self,
        policy: Union[str, type[ActorCriticPolicy]],
        env: Union[GymEnv, str],
        learning_rate: Union[float, Schedule] = 7e-4,
        n_steps: int = 5,
        gamma: float = 0.99,
        gae_lambda: float = 1.0,
        ent_coef: float = 0.0,
        vf_coef: float = 0.5,
        max_grad_norm: float = 0.5,
        rms_prop_eps: float = 1e-5,
        use_rms_prop: bool = True,
        use_sde: bool = False,
        sde_sample_freq: int = -1,
        rollout_buffer_class: Optional[type[RolloutBuffer]] = None,
        rollout_buffer_kwargs: Optional[dict[str, Any]] = None,
        normalize_advantage: bool = False,
        stats_window_size: int = 100,
        tensorboard_log: Optional[str] = None,
        policy_kwargs: Optional[dict[str, Any]] = None,
        verbose: int = 0,
        seed: Optional[int] = None,
        device: Union[th.device, str] = "auto",
        _init_setup_model: bool = True,
    ):
        ...
    
    def train(self) -> None:
        ...
    
    def learn(
        self: SelfA2C,
        total_timesteps: int,
        callback: MaybeCallback = None,
        log_interval: int = 100,
        tb_log_name: str = "A2C",
        reset_num_timesteps: bool = True,
        progress_bar: bool = False,
    ) -> SelfA2C:
        ...
```

**Key Parameters**:
- `policy`: Policy model type (MlpPolicy, CnnPolicy, etc.)
- `env`: Learning environment
- `learning_rate`: Learning rate for optimization
- `n_steps`: Number of steps per environment per update
- `normalize_advantage`: Whether to normalize advantages

**Core Methods**:

- **`train()`**:
  - **Function**: Perform one gradient step update using the gathered rollout data.
  - **Details**: Computes policy gradient loss, value loss, and entropy loss; performs backpropagation with gradient clipping.

- **`learn(...)`**:
  - **Function**: Train the A2C model for specified timesteps.
  - **Parameters**:
    - `total_timesteps`: Total number of training timesteps
    - `callback`: Callback functions for training
    - `log_interval`: Logging frequency
  - **Return Value**: Returns the trained SelfA2C instance.

#### 2. `BaseModel` Class - Base model for making predictions in response to observations

**Function**: Base model object that makes predictions in response to observations - for policies, the prediction is an action; for critics, it is the estimated value of the observation.

**Class Definition**:
```python
class BaseModel(nn.Module):
    def __init__(
        self,
        observation_space: spaces.Space,
        action_space: spaces.Space,
        features_extractor_class: type[BaseFeaturesExtractor] = FlattenExtractor,
        features_extractor_kwargs: Optional[dict[str, Any]] = None,
        features_extractor: Optional[BaseFeaturesExtractor] = None,
        normalize_images: bool = True,
        optimizer_class: type[th.optim.Optimizer] = th.optim.Adam,
        optimizer_kwargs: Optional[dict[str, Any]] = None,
    ):
        ...
    def _update_features_extractor(
        self,
        net_kwargs: dict[str, Any],
        features_extractor: Optional[BaseFeaturesExtractor] = None,
    ) -> dict[str, Any]:
        ...
    def make_features_extractor(self) -> BaseFeaturesExtractor:
        ...
    def extract_features(self, obs: PyTorchObs, features_extractor: BaseFeaturesExtractor) -> th.Tensor:
        ...
    def _get_constructor_parameters(self) -> dict[str, Any]:
        ...
    @property
    def device(self) -> th.device:
        ...
    def save(self, path: str) -> None:
        ...
    @classmethod
    def load(cls: type[SelfBaseModel], path: str, device: Union[th.device, str] = "auto") -> SelfBaseModel:
        ...
    def load_from_vector(self, vector: np.ndarray) -> None:
        ...
    def parameters_to_vector(self) -> np.ndarray:
        ...
    def set_training_mode(self, mode: bool) -> None:
        ...
    def is_vectorized_observation(self, observation: Union[np.ndarray, dict[str, np.ndarray]]) -> bool:
        ...
    def obs_to_tensor(self, observation: Union[np.ndarray, dict[str, np.ndarray]]) -> tuple[PyTorchObs, bool]:
        ...
```

**Methods**:

- `__init__(observation_space, action_space, features_extractor_class=FlattenExtractor, features_extractor_kwargs=None, features_extractor=None, normalize_images=True, optimizer_class=th.optim.Adam, optimizer_kwargs=None)`:
  - **Function**: Initialize the base model
  - **Parameters**:
    - `observation_space`: The observation space of the environment
    - `action_space`: The action space of the environment
    - `features_extractor_class`: Features extractor to use
    - `features_extractor_kwargs`: Keyword arguments to pass to the features extractor
    - `features_extractor`: Network to extract features
    - `normalize_images`: Whether to normalize images or not, dividing by 255.0
    - `optimizer_class`: The optimizer to use
    - `optimizer_kwargs`: Additional keyword arguments, excluding the learning rate, to pass to the optimizer

- `_update_features_extractor(net_kwargs, features_extractor=None)`:
  - **Function**: Update the network keyword arguments and create a new features extractor object if needed
  - **Parameters**:
    - `net_kwargs`: the base network keyword arguments, without the ones related to features extractor
    - `features_extractor`: a features extractor object. If None, a new object will be created
  - **Return Value**: The updated keyword arguments

- `make_features_extractor()`:
  - **Function**: Helper method to create a features extractor
  - **Return Value**: BaseFeaturesExtractor instance

- `extract_features(obs, features_extractor)`:
  - **Function**: Preprocess the observation if needed and extract features
  - **Parameters**:
    - `obs`: Observation
    - `features_extractor`: The features extractor to use
  - **Return Value**: The extracted features

- `_get_constructor_parameters()`:
  - **Function**: Get data that need to be saved in order to re-create the model when loading it from disk
  - **Return Value**: The dictionary to pass to the as kwargs constructor when reconstruction this model

- `device`:
  - **Function**: Infer which device this policy lives on by inspecting its parameters
  - **Return Value**: th.device

- `save(path)`:
  - **Function**: Save model to a given location
  - **Parameters**:
    - `path`: Save location

- `load(path, device="auto")`:
  - **Function**: Load model from path
  - **Parameters**:
    - `path`: Load path
    - `device`: Device on which the policy should be loaded
  - **Return Value**: Loaded model instance

- `load_from_vector(vector)`:
  - **Function**: Load parameters from a 1D vector
  - **Parameters**:
    - `vector`: Parameter vector

- `parameters_to_vector()`:
  - **Function**: Convert the parameters to a 1D vector
  - **Return Value**: Parameter vector as numpy array

- `set_training_mode(mode)`:
  - **Function**: Put the policy in either training or evaluation mode
  - **Parameters**:
    - `mode`: if true, set to training mode, else set to evaluation mode

- `is_vectorized_observation(observation)`:
  - **Function**: Check whether or not the observation is vectorized
  - **Parameters**:
    - `observation`: the input observation to check
  - **Return Value**: whether the given observation is vectorized or not

- `obs_to_tensor(observation)`:
  - **Function**: Convert an input observation to a PyTorch tensor that can be fed to a model
  - **Parameters**:
    - `observation`: the input observation
  - **Return Value**: The observation as PyTorch tensor and whether the observation is vectorized or not

#### 3. `BasePolicy` Class - Base policy object

**Function**: The base policy object, extending BaseModel with policy-specific functionality

**Class Definition**:
```python
class BasePolicy(BaseModel, ABC):
    def __init__(self, *args, squash_output: bool = False, **kwargs):
        ...
    @staticmethod
    def _dummy_schedule(progress_remaining: float) -> float:
        ...
    @property
    def squash_output(self) -> bool:
        ...
    @staticmethod
    def init_weights(module: nn.Module, gain: float = 1) -> None:
        ...
    @abstractmethod
    def _predict(self, observation: PyTorchObs, deterministic: bool = False) -> th.Tensor:
        ...
    def predict(
        self,
        observation: Union[np.ndarray, dict[str, np.ndarray]],
        state: Optional[tuple[np.ndarray, ...]] = None,
        episode_start: Optional[np.ndarray] = None,
        deterministic: bool = False,
    ) -> tuple[np.ndarray, Optional[tuple[np.ndarray, ...]]]:
        ...
    def scale_action(self, action: np.ndarray) -> np.ndarray:
        ...
    def unscale_action(self, scaled_action: np.ndarray) -> np.ndarray:
        ...
```

**Methods**:

- `__init__(*args, squash_output=False, **kwargs)`:
  - **Function**: Initialize the base policy
  - **Parameters**:
    - `squash_output`: For continuous actions, whether the output is squashed or not using a tanh() function

- `_dummy_schedule(progress_remaining)`:
  - **Function**: Useful for pickling policy
  - **Parameters**:
    - `progress_remaining`: Progress remaining
  - **Return Value**: 0.0

- `squash_output`:
  - **Function**: Getter for squash_output
  - **Return Value**: bool

- `init_weights(module, gain=1)`:
  - **Function**: Orthogonal initialization (used in PPO and A2C)
  - **Parameters**:
    - `module`: Neural network module
    - `gain`: Gain factor for initialization

- `_predict(observation, deterministic=False)`:
  - **Function**: Get the action according to the policy for a given observation (abstract method)
  - **Parameters**:
    - `observation`: Observation
    - `deterministic`: Whether to use stochastic or deterministic actions
  - **Return Value**: Taken action according to the policy

- `predict(observation, state=None, episode_start=None, deterministic=False)`:
  - **Function**: Get the policy action from an observation (and optional hidden state)
  - **Parameters**:
    - `observation`: the input observation
    - `state`: The last hidden states (can be None, used in recurrent policies)
    - `episode_start`: The last masks (can be None, used in recurrent policies)
    - `deterministic`: Whether or not to return deterministic actions
  - **Return Value**: the model's action and the next hidden state

- `scale_action(action)`:
  - **Function**: Rescale the action from [low, high] to [-1, 1]
  - **Parameters**:
    - `action`: Action to scale
  - **Return Value**: Scaled action

- `unscale_action(scaled_action)`:
  - **Function**: Rescale the action from [-1, 1] to [low, high]
  - **Parameters**:
    - `scaled_action`: Action to un-scale
  - **Return Value**: Unscaled action

#### 4. `ActorCriticPolicy` Class - Policy for actor-critic algorithms

**Function**: Policy class for actor-critic algorithms (has both policy and value prediction), used by A2C, PPO and similar algorithms

**Class Definition**:
```python
class ActorCriticPolicy(BasePolicy):
    def __init__(
        self,
        observation_space: spaces.Space,
        action_space: spaces.Space,
        lr_schedule: Schedule,
        net_arch: Optional[Union[list[int], dict[str, list[int]]]] = None,
        activation_fn: type[nn.Module] = nn.Tanh,
        ortho_init: bool = True,
        use_sde: bool = False,
        log_std_init: float = 0.0,
        full_std: bool = True,
        use_expln: bool = False,
        squash_output: bool = False,
        features_extractor_class: type[BaseFeaturesExtractor] = FlattenExtractor,
        features_extractor_kwargs: Optional[dict[str, Any]] = None,
        share_features_extractor: bool = True,
        normalize_images: bool = True,
        optimizer_class: type[th.optim.Optimizer] = th.optim.Adam,
        optimizer_kwargs: Optional[dict[str, Any]] = None,
    ):
        ...
    def _get_constructor_parameters(self) -> dict[str, Any]:
        ...
    def reset_noise(self, n_envs: int = 1) -> None:
        ...
    def _build_mlp_extractor(self) -> None:
        ...
    def _build(self, lr_schedule: Schedule) -> None:
        ...
    def forward(self, obs: th.Tensor, deterministic: bool = False) -> tuple[th.Tensor, th.Tensor, th.Tensor]:
        ...
    def extract_features(self, obs: PyTorchObs, features_extractor: Optional[BaseFeaturesExtractor] = None) -> Union[th.Tensor, tuple[th.Tensor, th.Tensor]]:
        ...
    def _get_action_dist_from_latent(self, latent_pi: th.Tensor) -> Distribution:
        ...
    def _predict(self, observation: PyTorchObs, deterministic: bool = False) -> th.Tensor:
        ...
    def evaluate_actions(self, obs: PyTorchObs, actions: th.Tensor) -> tuple[th.Tensor, th.Tensor, Optional[th.Tensor]]:
        ...
    def get_distribution(self, obs: PyTorchObs) -> Distribution:
        ...
    def predict_values(self, obs: PyTorchObs) -> th.Tensor:
        ...
```

**Methods**:

- `__init__(observation_space, action_space, lr_schedule, net_arch=None, activation_fn=nn.Tanh, ortho_init=True, use_sde=False, log_std_init=0.0, full_std=True, use_expln=False, squash_output=False, features_extractor_class=FlattenExtractor, features_extractor_kwargs=None, share_features_extractor=True, normalize_images=True, optimizer_class=th.optim.Adam, optimizer_kwargs=None)`:
  - **Function**: Initialize actor-critic policy
  - **Parameters**:
    - `lr_schedule`: Learning rate schedule (could be constant)
    - `net_arch`: The specification of the policy and value networks
    - `activation_fn`: Activation function
    - `ortho_init`: Whether to use or not orthogonal initialization
    - `use_sde`: Whether to use State Dependent Exploration or not
    - `log_std_init`: Initial value for the log standard deviation
    - `full_std`: Whether to use (n_features x n_actions) parameters for the std
    - `use_expln`: Use expln() function instead of exp() to ensure positive standard deviation
    - `share_features_extractor`: If True, the features extractor is shared between policy and value networks

- `reset_noise(n_envs=1)`:
  - **Function**: Sample new weights for the exploration matrix
  - **Parameters**:
    - `n_envs`: Number of environments

- `_build_mlp_extractor()`:
  - **Function**: Create the policy and value networks

- `_build(lr_schedule)`:
  - **Function**: Create the networks and the optimizer
  - **Parameters**:
    - `lr_schedule`: Learning rate schedule

- `forward(obs, deterministic=False)`:
  - **Function**: Forward pass in all the networks (actor and critic)
  - **Parameters**:
    - `obs`: Observation
    - `deterministic`: Whether to sample or use deterministic actions
  - **Return Value**: action, value and log probability of the action

- `extract_features(obs, features_extractor=None)`:
  - **Function**: Preprocess the observation if needed and extract features
  - **Parameters**:
    - `obs`: Observation
    - `features_extractor`: The features extractor to use
  - **Return Value**: The extracted features

- `_get_action_dist_from_latent(latent_pi)`:
  - **Function**: Retrieve action distribution given the latent codes
  - **Parameters**:
    - `latent_pi`: Latent code for the actor
  - **Return Value**: Action distribution

- `evaluate_actions(obs, actions)`:
  - **Function**: Evaluate actions according to the current policy
  - **Parameters**:
    - `obs`: Observation
    - `actions`: Actions
  - **Return Value**: estimated value, log likelihood of taking those actions and entropy

- `get_distribution(obs)`:
  - **Function**: Get the current policy distribution given the observations
  - **Parameters**:
    - `obs`: Observation
  - **Return Value**: the action distribution

- `predict_values(obs)`:
  - **Function**: Get the estimated values according to the current policy given the observations
  - **Parameters**:
    - `obs`: Observation
  - **Return Value**: the estimated values

#### 5. `ActorCriticCnnPolicy` Class - CNN policy for actor-critic algorithms

**Function**: CNN policy class for actor-critic algorithms (has both policy and value prediction), used by A2C, PPO and similar algorithms

**Class Definition**:
```python
class ActorCriticCnnPolicy(ActorCriticPolicy):
    def __init__(
        self,
        observation_space: spaces.Space,
        action_space: spaces.Space,
        lr_schedule: Schedule,
        net_arch: Optional[Union[list[int], dict[str, list[int]]]] = None,
        activation_fn: type[nn.Module] = nn.Tanh,
        ortho_init: bool = True,
        use_sde: bool = False,
        log_std_init: float = 0.0,
        full_std: bool = True,
        use_expln: bool = False,
        squash_output: bool = False,
        features_extractor_class: type[BaseFeaturesExtractor] = NatureCNN,
        features_extractor_kwargs: Optional[dict[str, Any]] = None,
        share_features_extractor: bool = True,
        normalize_images: bool = True,
        optimizer_class: type[th.optim.Optimizer] = th.optim.Adam,
        optimizer_kwargs: Optional[dict[str, Any]] = None,
    ):
        ...
```

#### 6. `MultiInputActorCriticPolicy` Class - Multi-input policy for actor-critic algorithms

**Function**: MultiInputActorClass policy class for actor-critic algorithms (has both policy and value prediction), used by A2C, PPO and similar algorithms

**Class Definition**:
```python
class MultiInputActorCriticPolicy(ActorCriticPolicy):
    def __init__(
        self,
        observation_space: spaces.Dict,
        action_space: spaces.Space,
        lr_schedule: Schedule,
        net_arch: Optional[Union[list[int], dict[str, list[int]]]] = None,
        activation_fn: type[nn.Module] = nn.Tanh,
        ortho_init: bool = True,
        use_sde: bool = False,
        log_std_init: float = 0.0,
        full_std: bool = True,
        use_expln: bool = False,
        squash_output: bool = False,
        features_extractor_class: type[BaseFeaturesExtractor] = CombinedExtractor,
        features_extractor_kwargs: Optional[dict[str, Any]] = None,
        share_features_extractor: bool = True,
        normalize_images: bool = True,
        optimizer_class: type[th.optim.Optimizer] = th.optim.Adam,
        optimizer_kwargs: Optional[dict[str, Any]] = None,
    ):
        ...
```

#### 7. `ContinuousCritic` Class - Critic network for continuous action spaces

**Function**: Critic network(s) for DDPG/SAC/TD3, representing the action-state value function (Q-value function) for continuous action spaces

**Class Definition**:
```python
class ContinuousCritic(BaseModel):
    def __init__(
        self,
        observation_space: spaces.Space,
        action_space: spaces.Box,
        net_arch: list[int],
        features_extractor: BaseFeaturesExtractor,
        features_dim: int,
        activation_fn: type[nn.Module] = nn.ReLU,
        normalize_images: bool = True,
        n_critics: int = 2,
        share_features_extractor: bool = True,
    ):
        ...
    def forward(self, obs: th.Tensor, actions: th.Tensor) -> tuple[th.Tensor, ...]:
        ...
    def q1_forward(self, obs: th.Tensor, actions: th.Tensor) -> th.Tensor:
        ...
```

**Methods**:

- `__init__(observation_space, action_space, net_arch, features_extractor, features_dim, activation_fn=nn.ReLU, normalize_images=True, n_critics=2, share_features_extractor=True)`:
  - **Function**: Initialize continuous critic
  - **Parameters**:
    - `net_arch`: Network architecture
    - `features_extractor`: Network to extract features
    - `features_dim`: Number of features
    - `n_critics`: Number of critic networks to create
    - `share_features_extractor`: Whether the features extractor is shared with the actor

- `forward(obs, actions)`:
  - **Function**: Forward pass through critic networks
  - **Parameters**:
    - `obs`: Observation
    - `actions`: Actions
  - **Return Value**: Tuple of Q-value estimates from all critics

- `q1_forward(obs, actions)`:
  - **Function**: Only predict the Q-value using the first network
  - **Parameters**:
    - `obs`: Observation
    - `actions`: Actions
  - **Return Value**: Q-value estimate from the first critic network


#### 8. `StickyActionEnv` Class - Sticky Action Environment Wrapper

**Function**: Implements sticky actions where the previous action may repeat with a given probability.

**Class Definition**:
```python
class StickyActionEnv(gym.Wrapper[np.ndarray, int, np.ndarray, int]):
    def __init__(self, env: gym.Env, action_repeat_probability: float) -> None:
        ...
    
    def reset(self, **kwargs) -> AtariResetReturn:
        ...
    
    def step(self, action: int) -> AtariStepReturn:
        ...
```

**Core Methods**:
- **`step(action)`**:
  - **Function**: Execute step with sticky action behavior.
  - **Parameters**: `action` (int): The intended action to take.
  - **Details**: With probability `action_repeat_probability`, repeats the last action instead of using the new one.

#### 9. `NoopResetEnv` Class - No-op Reset Environment Wrapper

**Function**: Performs random number of no-op actions on environment reset.

**Class Definition**:
```python
class NoopResetEnv(gym.Wrapper[np.ndarray, int, np.ndarray, int]):
    def __init__(self, env: gym.Env, noop_max: int = 30) -> None:
        ...
    
    def reset(self, **kwargs) -> AtariResetReturn:
        ...
```

**Core Methods**:
- **`reset(**kwargs)`**:
  - **Function**: Reset environment and perform random no-op actions.
  - **Details**: Executes 1 to `noop_max` no-op actions (action 0) after reset.

#### 10. `FireResetEnv` Class - Fire Reset Environment Wrapper

**Function**: Performs FIRE action on reset for environments that require it.

**Class Definition**:
```python
class FireResetEnv(gym.Wrapper[np.ndarray, int, np.ndarray, int]):
    def __init__(self, env: gym.Env) -> None:
        ...
    
    def reset(self, **kwargs) -> AtariResetReturn:
        ...
```

**Core Methods**:
- **`reset(**kwargs)`**:
  - **Function**: Reset environment and execute FIRE action sequence.
  - **Details**: Performs actions 1 (FIRE) and 2 to start the game.

#### 11. `EpisodicLifeEnv` Class - Episodic Life Environment Wrapper

**Function**: Treats loss of life as end of episode for better value estimation.

**Class Definition**:
```python
class EpisodicLifeEnv(gym.Wrapper[np.ndarray, int, np.ndarray, int]):
    def __init__(self, env: gym.Env) -> None:
        ...
    
    def step(self, action: int) -> AtariStepReturn:
        ...
    
    def reset(self, **kwargs) -> AtariResetReturn:
        ...
```

**Core Methods**:
- **`step(action)`**:
  - **Function**: Execute step and check for life loss.
  - **Details**: Sets terminated=True when a life is lost (but game continues).
- **`reset(**kwargs)`**:
  - **Function**: Reset only on true game over, not on life loss.

#### 12. `MaxAndSkipEnv` Class - Max and Skip Environment Wrapper

**Function**: Skips frames and returns max of last two observations.

**Class Definition**:
```python
class MaxAndSkipEnv(gym.Wrapper[np.ndarray, int, np.ndarray, int]):
    def __init__(self, env: gym.Env, skip: int = 4) -> None:
        ...
    
    def step(self, action: int) -> AtariStepReturn:
        ...
```

**Core Methods**:
- **`step(action)`**:
  - **Function**: Repeat action for `skip` frames and return max-pooled observation.
  - **Return Value**: Max of last two frames, summed reward over skipped frames.

#### 13. `ClipRewardEnv` Class - Clip Reward Environment Wrapper

**Function**: Clips rewards to {-1, 0, +1} based on sign.

**Class Definition**:
```python
class ClipRewardEnv(gym.RewardWrapper):
    def __init__(self, env: gym.Env) -> None:
        ...
    
    def reward(self, reward: SupportsFloat) -> float:
        ...
```

**Core Methods**:
- **`reward(reward)`**:
  - **Function**: Clip reward to its sign.
  - **Return Value**: -1, 0, or +1 depending on reward sign.

#### 14. `WarpFrame` Class - Warp Frame Observation Wrapper

**Function**: Converts frames to grayscale and resizes to specified dimensions.

**Class Definition**:
```python
class WarpFrame(gym.ObservationWrapper[np.ndarray, int, np.ndarray]):
    def __init__(self, env: gym.Env, width: int = 84, height: int = 84) -> None:
        ...
    
    def observation(self, frame: np.ndarray) -> np.ndarray:
        ...
```

**Core Methods**:
- **`observation(frame)`**:
  - **Function**: Convert frame to grayscale and resize.
  - **Return Value**: Processed observation of shape (height, width, 1).

#### 15. `AtariWrapper` Class - Comprehensive Atari Preprocessing Wrapper

**Function**: Applies standard Atari 2600 preprocessing pipeline.

**Class Definition**:
```python
class AtariWrapper(gym.Wrapper[np.ndarray, int, np.ndarray, int]):
    def __init__(
        self,
        env: gym.Env,
        noop_max: int = 30,
        frame_skip: int = 4,
        screen_size: int = 84,
        terminal_on_life_loss: bool = True,
        clip_reward: bool = True,
        action_repeat_probability: float = 0.0,
    ) -> None:
        ...
```

**Key Parameters**:
- `noop_max`: Maximum no-op actions on reset
- `frame_skip`: Frame skipping frequency
- `screen_size`: Size for resized frames
- `terminal_on_life_loss`: Whether life loss ends episode
- `clip_reward`: Whether to clip rewards
- `action_repeat_probability`: Sticky action probability


#### 16. `maybe_make_env` Function - Create environment from string or return existing

**Function**: If env is a string, make the environment; otherwise, return env.

**Function Signature**:
```python
def maybe_make_env(env: Union[GymEnv, str], verbose: int) -> GymEnv: ...
```

**Parameter Description**:
- `env`: The environment to learn from
- `verbose`: Verbosity level: 0 for no output, 1 for indicating if environment is created

**Return Value**: A Gym (vector) environment

#### 17. `BaseAlgorithm` Class - Base class for RL algorithms

**Function**: The base of RL algorithms, providing common functionality for training and model management.

**Class Definition**:
```python
class BaseAlgorithm(ABC):
    policy_aliases: ClassVar[dict[str, type[BasePolicy]]] = {}
    
    def __init__(
        self,
        policy: Union[str, type[BasePolicy]],
        env: Union[GymEnv, str, None],
        learning_rate: Union[float, Schedule],
        policy_kwargs: Optional[dict[str, Any]] = None,
        stats_window_size: int = 100,
        tensorboard_log: Optional[str] = None,
        verbose: int = 0,
        device: Union[th.device, str] = "auto",
        support_multi_env: bool = False,
        monitor_wrapper: bool = True,
        seed: Optional[int] = None,
        use_sde: bool = False,
        sde_sample_freq: int = -1,
        supported_action_spaces: Optional[tuple[type[spaces.Space], ...]] = None,
    ) -> None:
        ...
    @staticmethod
    def _wrap_env(env: GymEnv, verbose: int = 0, monitor_wrapper: bool = True) -> VecEnv:
        ...
    @abstractmethod
    def _setup_model(self) -> None:
        ...
    def set_logger(self, logger: Logger) -> None:
        ...
    @property
    def logger(self) -> Logger:
        ...
    def _setup_lr_schedule(self) -> None:
        ...
    def _update_current_progress_remaining(self, num_timesteps: int, total_timesteps: int) -> None:
        ...
    def _update_learning_rate(self, optimizers: Union[list[th.optim.Optimizer], th.optim.Optimizer]) -> None:
        ...
    def _excluded_save_params(self) -> list[str]:
        ...
    def _get_policy_from_name(self, policy_name: str) -> type[BasePolicy]:
        ...
    def _get_torch_save_params(self) -> tuple[list[str], list[str]]:
        ...
    def _init_callback(
        self,
        callback: MaybeCallback,
        progress_bar: bool = False,
    ) -> BaseCallback:
        ...
    def _setup_learn(
        self,
        total_timesteps: int,
        callback: MaybeCallback = None,
        reset_num_timesteps: bool = True,
        tb_log_name: str = "run",
        progress_bar: bool = False,
    ) -> tuple[int, BaseCallback]:
        ...
    def _update_info_buffer(self, infos: list[dict[str, Any]], dones: Optional[np.ndarray] = None) -> None:
        ...
    def get_env(self) -> Optional[VecEnv]:
        ...
    def get_vec_normalize_env(self) -> Optional[VecNormalize]:
        ...
    def set_env(self, env: GymEnv, force_reset: bool = True) -> None:
        ...
    @abstractmethod
    def learn(
        self: SelfBaseAlgorithm,
        total_timesteps: int,
        callback: MaybeCallback = None,
        log_interval: int = 100,
        tb_log_name: str = "run",
        reset_num_timesteps: bool = True,
        progress_bar: bool = False,
    ) -> SelfBaseAlgorithm:
        ...
    def predict(
        self,
        observation: Union[np.ndarray, dict[str, np.ndarray]],
        state: Optional[tuple[np.ndarray, ...]] = None,
        episode_start: Optional[np.ndarray] = None,
        deterministic: bool = False,
    ) -> tuple[np.ndarray, Optional[tuple[np.ndarray, ...]]]:
        ...
    def set_random_seed(self, seed: Optional[int] = None) -> None:
        ...
    def set_parameters(
        self,
        load_path_or_dict: Union[str, TensorDict],
        exact_match: bool = True,
        device: Union[th.device, str] = "auto",
    ) -> None:
        ...
    @classmethod
    def load(
        cls: type[SelfBaseAlgorithm],
        path: Union[str, pathlib.Path, io.BufferedIOBase],
        env: Optional[GymEnv] = None,
        device: Union[th.device, str] = "auto",
        custom_objects: Optional[dict[str, Any]] = None,
        print_system_info: bool = False,
        force_reset: bool = True,
        **kwargs,
    ) -> SelfBaseAlgorithm:
        ...
    def get_parameters(self) -> dict[str, dict]:
        ...
    def save(
        self,
        path: Union[str, pathlib.Path, io.BufferedIOBase],
        exclude: Optional[Iterable[str]] = None,
        include: Optional[Iterable[str]] = None,
    ) -> None:
        ...
    def dump_logs(self) -> None:
        ...
    def _dump_logs(self, *args) -> None:
        ...
```

**Methods**:

- `__init__(policy, env, learning_rate, policy_kwargs=None, stats_window_size=100, tensorboard_log=None, verbose=0, device="auto", support_multi_env=False, monitor_wrapper=True, seed=None, use_sde=False, sde_sample_freq=-1, supported_action_spaces=None)`:
  - **Function**: Initialize the base RL algorithm
  - **Parameters**:
    - `policy`: The policy model to use (MlpPolicy, CnnPolicy, ...)
    - `env`: The environment to learn from (can be None for loading trained models)
    - `learning_rate`: learning rate for the optimizer, can be a function of current progress
    - `policy_kwargs`: Additional arguments for policy creation
    - `stats_window_size`: Window size for rollout logging
    - `tensorboard_log`: Log location for tensorboard
    - `verbose`: Verbosity level
    - `device`: Device to run on
    - `support_multi_env`: Whether algorithm supports multiple environments
    - `monitor_wrapper`: Whether to wrap env in Monitor wrapper
    - `seed`: Seed for pseudo random generators
    - `use_sde`: Whether to use State Dependent Exploration
    - `sde_sample_freq`: Sample noise frequency for gSDE
    - `supported_action_spaces`: Supported action spaces

- `_wrap_env(env, verbose=0, monitor_wrapper=True)`:
  - **Function**: Wrap environment with appropriate wrappers if needed
  - **Parameters**:
    - `env`: Environment to wrap
    - `verbose`: Verbosity level
    - `monitor_wrapper`: Whether to wrap in Monitor wrapper
  - **Return Value**: The wrapped environment

- `_setup_model()`:
  - **Function**: Create networks, buffer and optimizers (abstract method)

- `set_logger(logger)`:
  - **Function**: Setter for logger object
  - **Parameters**:
    - `logger`: Logger object

- `logger`:
  - **Function**: Getter for the logger object
  - **Return Value**: Logger instance

- `_setup_lr_schedule()`:
  - **Function**: Transform learning rate to callable if needed

- `_update_current_progress_remaining(num_timesteps, total_timesteps)`:
  - **Function**: Compute current progress remaining (from 1 to 0)
  - **Parameters**:
    - `num_timesteps`: current number of timesteps
    - `total_timesteps`: total timesteps

- `_update_learning_rate(optimizers)`:
  - **Function**: Update optimizers learning rate using current schedule
  - **Parameters**:
    - `optimizers`: An optimizer or list of optimizers

- `_excluded_save_params()`:
  - **Function**: Get parameter names to exclude from pickling
  - **Return Value**: List of parameter names to exclude

- `_get_policy_from_name(policy_name)`:
  - **Function**: Get policy class from its name representation
  - **Parameters**:
    - `policy_name`: Alias of the policy
  - **Return Value**: A policy class

- `_get_torch_save_params()`:
  - **Function**: Get torch variables to save with PyTorch save/load
  - **Return Value**: Tuple of state dict names and other torch variables

- `_init_callback(callback, progress_bar=False)`:
  - **Function**: Initialize callbacks for training
  - **Parameters**:
    - `callback`: Callback(s) called at every step
    - `progress_bar`: Display progress bar
  - **Return Value**: A hybrid callback

- `_setup_learn(total_timesteps, callback=None, reset_num_timesteps=True, tb_log_name="run", progress_bar=False)`:
  - **Function**: Initialize variables needed for training
  - **Parameters**:
    - `total_timesteps`: Total samples to train on
    - `callback`: Callback(s) for training
    - `reset_num_timesteps`: Whether to reset timestep counter
    - `tb_log_name`: Name for tensorboard log
    - `progress_bar`: Display progress bar
  - **Return Value**: Total timesteps and callback

- `_update_info_buffer(infos, dones=None)`:
  - **Function**: Retrieve reward, episode length, success and update buffer
  - **Parameters**:
    - `infos`: Additional information about transition
    - `dones`: Termination signals

- `get_env()`:
  - **Function**: Get current environment
  - **Return Value**: Current environment or None

- `get_vec_normalize_env()`:
  - **Function**: Get VecNormalize wrapper if it exists
  - **Return Value**: VecNormalize environment or None

- `set_env(env, force_reset=True)`:
  - **Function**: Set and validate new environment
  - **Parameters**:
    - `env`: New environment for learning
    - `force_reset`: Force reset before training

- `learn(total_timesteps, callback=None, log_interval=100, tb_log_name="run", reset_num_timesteps=True, progress_bar=False)`:
  - **Function**: Return a trained model (abstract method)
  - **Parameters**:
    - `total_timesteps`: Total samples to train on
    - `callback`: Callback(s) for training
    - `log_interval`: Logging interval
    - `tb_log_name`: TensorBoard run name
    - `reset_num_timesteps`: Reset timestep counter
    - `progress_bar`: Display progress bar
  - **Return Value**: Trained model

- `predict(observation, state=None, episode_start=None, deterministic=False)`:
  - **Function**: Get policy action from observation
  - **Parameters**:
    - `observation`: Input observation
    - `state`: Last hidden states
    - `episode_start`: Episode start masks
    - `deterministic`: Return deterministic actions
  - **Return Value**: Action and next hidden state

- `set_random_seed(seed=None)`:
  - **Function**: Set seed for pseudo-random generators
  - **Parameters**:
    - `seed`: Random seed

- `set_parameters(load_path_or_dict, exact_match=True, device="auto")`:
  - **Function**: Load parameters from zip-file or dictionary
  - **Parameters**:
    - `load_path_or_dict`: Saved data location or parameters dictionary
    - `exact_match`: Require exact parameter match
    - `device`: Device to run on

- `load(path, env=None, device="auto", custom_objects=None, print_system_info=False, force_reset=True, **kwargs)`:
  - **Function**: Load model from zip-file
  - **Parameters**:
    - `path`: Path to saved file
    - `env`: New environment to run model on
    - `device`: Device to run on
    - `custom_objects`: Objects to replace upon loading
    - `print_system_info`: Print system info for debugging
    - `force_reset`: Force reset before training
    - `kwargs`: Extra arguments for model loading
  - **Return Value**: New model instance with loaded parameters

- `get_parameters()`:
  - **Function**: Get agent parameters from different networks
  - **Return Value**: Mapping of object names to PyTorch state-dicts

- `save(path, exclude=None, include=None)`:
  - **Function**: Save object attributes and model parameters to zip-file
  - **Parameters**:
    - `path`: Save file path
    - `exclude`: Parameters to exclude
    - `include`: Parameters to include despite exclusion

- `dump_logs()`:
  - **Function**: Write log data
  - **Details**: Implemented by OffPolicyAlgorithm and OnPolicyAlgorithm

- `_dump_logs(*args)`:
  - **Function**: Deprecated version of dump_logs

#### 18. `BaseBuffer` Class - Base class for buffers (rollout or replay)

**Function**: Base class that represent a buffer (rollout or replay) for storing and sampling transitions.

**Class Definition**:
```python
class BaseBuffer(ABC):
    def __init__(
        self,
        buffer_size: int,
        observation_space: spaces.Space,
        action_space: spaces.Space,
        device: Union[th.device, str] = "auto",
        n_envs: int = 1,
    ):
        ...
    @staticmethod
    def swap_and_flatten(arr: np.ndarray) -> np.ndarray:
        ...
    def size(self) -> int:
        ...
    def add(self, *args, **kwargs) -> None:
        ...
    def extend(self, *args, **kwargs) -> None:
        ...
    def reset(self) -> None:
        ...
    def sample(self, batch_size: int, env: Optional[VecNormalize] = None):
        ...
    @abstractmethod
    def _get_samples(
        self, batch_inds: np.ndarray, env: Optional[VecNormalize] = None
    ) -> Union[ReplayBufferSamples, RolloutBufferSamples]:
        ...
    def to_torch(self, array: np.ndarray, copy: bool = True) -> th.Tensor:
        ...
    @staticmethod
    def _normalize_obs(
        obs: Union[np.ndarray, dict[str, np.ndarray]],
        env: Optional[VecNormalize] = None,
    ) -> Union[np.ndarray, dict[str, np.ndarray]]:
        ...
    @staticmethod
    def _normalize_reward(reward: np.ndarray, env: Optional[VecNormalize] = None) -> np.ndarray:
        ...
```

**Methods**:

- `__init__(buffer_size, observation_space, action_space, device="auto", n_envs=1)`:
  - **Function**: Initialize the base buffer
  - **Parameters**:
    - `buffer_size`: Max number of element in the buffer
    - `observation_space`: Observation space
    - `action_space`: Action space
    - `device`: PyTorch device
    - `n_envs`: Number of parallel environments

- `swap_and_flatten(arr)`:
  - **Function**: Swap and flatten axes 0 (buffer_size) and 1 (n_envs)
  - **Parameters**:
    - `arr`: Array to reshape
  - **Return Value**: Reshaped array

- `size()`:
  - **Function**: Get current size of the buffer
  - **Return Value**: Current buffer size

- `add(*args, **kwargs)`:
  - **Function**: Add elements to the buffer (abstract)

- `extend(*args, **kwargs)`:
  - **Function**: Add a new batch of transitions to the buffer

- `reset()`:
  - **Function**: Reset the buffer

- `sample(batch_size, env=None)`:
  - **Function**: Sample elements from the buffer
  - **Parameters**:
    - `batch_size`: Number of element to sample
    - `env`: Associated VecEnv for normalization
  - **Return Value**: Sampled transitions

- `_get_samples(batch_inds, env=None)`:
  - **Function**: Get samples for given batch indices (abstract)
  - **Parameters**:
    - `batch_inds`: Batch indices
    - `env`: VecEnv for normalization
  - **Return Value**: Buffer samples

- `to_torch(array, copy=True)`:
  - **Function**: Convert numpy array to PyTorch tensor
  - **Parameters**:
    - `array`: Numpy array
    - `copy`: Whether to copy data
  - **Return Value**: PyTorch tensor

- `_normalize_obs(obs, env=None)`:
  - **Function**: Normalize observations using VecNormalize
  - **Parameters**:
    - `obs`: Observations to normalize
    - `env`: VecNormalize environment
  - **Return Value**: Normalized observations

- `_normalize_reward(reward, env=None)`:
  - **Function**: Normalize rewards using VecNormalize
  - **Parameters**:
    - `reward`: Rewards to normalize
    - `env`: VecNormalize environment
  - **Return Value**: Normalized rewards

#### 19. `ReplayBuffer` Class - Replay buffer for off-policy algorithms

**Function**: Replay buffer used in off-policy algorithms like SAC/TD3 for storing and sampling transitions.

**Class Definition**:
```python
class ReplayBuffer(BaseBuffer):
    def __init__(
        self,
        buffer_size: int,
        observation_space: spaces.Space,
        action_space: spaces.Space,
        device: Union[th.device, str] = "auto",
        n_envs: int = 1,
        optimize_memory_usage: bool = False,
        handle_timeout_termination: bool = True,
    ):
        ...
    def add(
        self,
        obs: np.ndarray,
        next_obs: np.ndarray,
        action: np.ndarray,
        reward: np.ndarray,
        done: np.ndarray,
        infos: list[dict[str, Any]],
    ) -> None:
        ...
    def sample(self, batch_size: int, env: Optional[VecNormalize] = None) -> ReplayBufferSamples:
        ...
    def _get_samples(self, batch_inds: np.ndarray, env: Optional[VecNormalize] = None) -> ReplayBufferSamples:
        ...
    @staticmethod
    def _maybe_cast_dtype(dtype: np.typing.DTypeLike) -> np.typing.DTypeLike:
        ...
```

**Methods**:

- `__init__(buffer_size, observation_space, action_space, device="auto", n_envs=1, optimize_memory_usage=False, handle_timeout_termination=True)`:
  - **Function**: Initialize replay buffer
  - **Parameters**:
    - `optimize_memory_usage`: Enable memory efficient variant
    - `handle_timeout_termination`: Handle timeout termination separately

- `add(obs, next_obs, action, reward, done, infos)`:
  - **Function**: Add transition to replay buffer
  - **Parameters**:
    - `obs`: Current observation
    - `next_obs`: Next observation
    - `action`: Action taken
    - `reward`: Reward received
    - `done`: Done flag
    - `infos`: Additional info dicts

- `sample(batch_size, env=None)`:
  - **Function**: Sample elements from replay buffer with memory optimization support
  - **Parameters**:
    - `batch_size`: Number of elements to sample
    - `env`: VecEnv for normalization
  - **Return Value**: ReplayBufferSamples

- `_get_samples(batch_inds, env=None)`:
  - **Function**: Get samples for given batch indices
  - **Parameters**:
    - `batch_inds`: Batch indices
    - `env`: VecEnv for normalization
  - **Return Value**: ReplayBufferSamples

- `_maybe_cast_dtype(dtype)`:
  - **Function**: Cast np.float64 to np.float32, keep others unchanged
  - **Parameters**:
    - `dtype`: Original dtype
  - **Return Value**: Casted dtype

#### 20. `RolloutBuffer` Class - Rollout buffer for on-policy algorithms

**Function**: Rollout buffer used in on-policy algorithms like A2C/PPO for storing and sampling rollout data.

**Class Definition**:
```python
class RolloutBuffer(BaseBuffer):
    def __init__(
        self,
        buffer_size: int,
        observation_space: spaces.Space,
        action_space: spaces.Space,
        device: Union[th.device, str] = "auto",
        gae_lambda: float = 1,
        gamma: float = 0.99,
        n_envs: int = 1,
    ):
        ...
    def reset(self) -> None:
        ...
    def compute_returns_and_advantage(self, last_values: th.Tensor, dones: np.ndarray) -> None:
        ...
    def add(
        self,
        obs: np.ndarray,
        action: np.ndarray,
        reward: np.ndarray,
        episode_start: np.ndarray,
        value: th.Tensor,
        log_prob: th.Tensor,
    ) -> None:
        ...
    def get(self, batch_size: Optional[int] = None) -> Generator[RolloutBufferSamples, None, None]:
        ...
    def _get_samples(
        self,
        batch_inds: np.ndarray,
        env: Optional[VecNormalize] = None,
    ) -> RolloutBufferSamples:
        ...
```

**Methods**:

- `__init__(buffer_size, observation_space, action_space, device="auto", gae_lambda=1, gamma=0.99, n_envs=1)`:
  - **Function**: Initialize rollout buffer
  - **Parameters**:
    - `gae_lambda`: GAE lambda parameter
    - `gamma`: Discount factor

- `reset()`:
  - **Function**: Reset the rollout buffer arrays

- `compute_returns_and_advantage(last_values, dones)`:
  - **Function**: Compute lambda-return and GAE advantage
  - **Parameters**:
    - `last_values`: State value estimation for last step
    - `dones`: Terminal step flags

- `add(obs, action, reward, episode_start, value, log_prob)`:
  - **Function**: Add transition to rollout buffer
  - **Parameters**:
    - `obs`: Observation
    - `action`: Action
    - `reward`: Reward
    - `episode_start`: Start of episode signal
    - `value`: Estimated state value
    - `log_prob`: Log probability of action

- `get(batch_size=None)`:
  - **Function**: Get rollout samples as generator
  - **Parameters**:
    - `batch_size`: Batch size for minibatches
  - **Return Value**: Generator of RolloutBufferSamples

- `_get_samples(batch_inds, env=None)`:
  - **Function**: Get samples for given batch indices
  - **Parameters**:
    - `batch_inds`: Batch indices
    - `env`: VecEnv for normalization
  - **Return Value**: RolloutBufferSamples

#### 21. `DictReplayBuffer` Class - Replay buffer for dictionary observations

**Function**: Dict Replay buffer used in off-policy algorithms like SAC/TD3 with dictionary observations.

**Class Definition**:
```python
class DictReplayBuffer(ReplayBuffer):
    def __init__(
        self,
        buffer_size: int,
        observation_space: spaces.Dict,
        action_space: spaces.Space,
        device: Union[th.device, str] = "auto",
        n_envs: int = 1,
        optimize_memory_usage: bool = False,
        handle_timeout_termination: bool = True,
    ):
        ...
    def add(
        self,
        obs: dict[str, np.ndarray],
        next_obs: dict[str, np.ndarray],
        action: np.ndarray,
        reward: np.ndarray,
        done: np.ndarray,
        infos: list[dict[str, Any]],
    ) -> None:
        ...
    def sample(
        self,
        batch_size: int,
        env: Optional[VecNormalize] = None,
    ) -> DictReplayBufferSamples:
        ...
    def _get_samples(
        self,
        batch_inds: np.ndarray,
        env: Optional[VecNormalize] = None,
    ) -> DictReplayBufferSamples:
        ...
```

**Methods**:

- `add(obs, next_obs, action, reward, done, infos)`:
  - **Function**: Add transition with dict observations to buffer
  - **Parameters**:
    - `obs`: Current dict observation
    - `next_obs`: Next dict observation
    - `action`: Action taken
    - `reward`: Reward received
    - `done`: Done flag
    - `infos`: Additional info dicts

- `sample(batch_size, env=None)`:
  - **Function**: Sample elements from dict replay buffer
  - **Parameters**:
    - `batch_size`: Number of elements to sample
    - `env`: VecEnv for normalization
  - **Return Value**: DictReplayBufferSamples

- `_get_samples(batch_inds, env=None)`:
  - **Function**: Get dict samples for given batch indices
  - **Parameters**:
    - `batch_inds`: Batch indices
    - `env`: VecEnv for normalization
  - **Return Value**: DictReplayBufferSamples

#### 22. `DictRolloutBuffer` Class - Rollout buffer for dictionary observations

**Function**: Dict Rollout buffer used in on-policy algorithms like A2C/PPO with dictionary observations.

**Class Definition**:
```python
class DictRolloutBuffer(RolloutBuffer):
    def __init__(
        self,
        buffer_size: int,
        observation_space: spaces.Dict,
        action_space: spaces.Space,
        device: Union[th.device, str] = "auto",
        gae_lambda: float = 1,
        gamma: float = 0.99,
        n_envs: int = 1,
    ):
        ...
    def reset(self) -> None:
        ...
    def add(
        self,
        obs: dict[str, np.ndarray],
        action: np.ndarray,
        reward: np.ndarray,
        episode_start: np.ndarray,
        value: th.Tensor,
        log_prob: th.Tensor,
    ) -> None:
        ...
    def get(
        self,
        batch_size: Optional[int] = None,
    ) -> Generator[DictRolloutBufferSamples, None, None]:
        ...
    def _get_samples(
        self,
        batch_inds: np.ndarray,
        env: Optional[VecNormalize] = None,
    ) -> DictRolloutBufferSamples:
        ...
```

**Methods**:

- `reset()`:
  - **Function**: Reset the dict rollout buffer arrays

- `add(obs, action, reward, episode_start, value, log_prob)`:
  - **Function**: Add transition with dict observations to buffer
  - **Parameters**:
    - `obs`: Dict observation
    - `action`: Action
    - `reward`: Reward
    - `episode_start`: Start of episode signal
    - `value`: Estimated state value
    - `log_prob`: Log probability of action

- `get(batch_size=None)`:
  - **Function**: Get dict rollout samples as generator
  - **Parameters**:
    - `batch_size`: Batch size for minibatches
  - **Return Value**: Generator of DictRolloutBufferSamples

- `_get_samples(batch_inds, env=None)`:
  - **Function**: Get dict samples for given batch indices
  - **Parameters**:
    - `batch_inds`: Batch indices
    - `env`: VecEnv for normalization
  - **Return Value**: DictRolloutBufferSamples

#### 23. `NStepReplayBuffer` Class - Replay buffer for n-step returns

**Function**: Replay buffer used for computing n-step returns in off-policy algorithms like SAC/DQN.

**Class Definition**:
```python
class NStepReplayBuffer(ReplayBuffer):
    def __init__(self, *args, n_steps: int = 3, gamma: float = 0.99, **kwargs):
        ...
    def _get_samples(self, batch_inds: np.ndarray, env: Optional[VecNormalize] = None) -> ReplayBufferSamples:
        ...
```

**Methods**:

- `__init__(*args, n_steps=3, gamma=0.99, **kwargs)`:
  - **Function**: Initialize n-step replay buffer
  - **Parameters**:
    - `n_steps`: Number of steps to accumulate rewards
    - `gamma`: Discount factor

- `_get_samples(batch_inds, env=None)`:
  - **Function**: Sample batch and compute n-step returns
  - **Parameters**:
    - `batch_inds`: Batch indices
    - `env`: VecEnv for normalization
  - **Return Value**: ReplayBufferSamples with n-step returns


#### 24. `BaseCallback` Class - Base Callback for Training Monitoring

**Path**: `workspace\stable_baselines3\common\callbacks.py`
**Function**: Abstract base class for all training callbacks in Stable Baselines3.

**Class Definition**:
```python
class BaseCallback(ABC):
  """
  Base class for callback.

  :param verbose: Verbosity level: 0 for no output, 1 for info messages, 2 for debug messages
  """
  model: "base_class.BaseAlgorithm"

  def __init__(self, verbose: int = 0):
      ...

  @property
  def training_env(self) -> VecEnv:
    ...
  
  @property
  def logger(self) -> Logger:
      ...

  def init_callback(self, model: "base_class.BaseAlgorithm") -> None:
      ...

  def _init_callback(self) -> None:
      ...

  @abstractmethod
  def _on_step(self) -> bool:
      ...

  def on_step(self) -> bool:
      ...

  def on_training_start(self, locals_: dict[str, Any], globals_: dict[str, Any]) -> None:
      ...

  def _on_training_start(self) -> None:
    ...

  def on_training_end(self) -> None:
      ...

  def _on_rollout_start(self) -> None: 
    ...
  
  def on_rollout_start(self) -> None:
      ...

  def on_rollout_end(self) -> None:
      ...
```

**Core Methods**:
- **`_on_step()`**: Abstract method called after each environment step.
- **`on_step()`**: Wrapper that updates counters and calls `_on_step()`.
- **`init_callback(model)`**: Initialize callback with model reference.

#### 25. `BaseCallback` Class - Base class for callbacks

**Function**: Base class for callback objects that can interact with the training process at various points.

**Class Definition**:
```python
class BaseCallback(ABC):
    def __init__(self, verbose: int = 0):
        ...
    @property
    def training_env(self) -> VecEnv:
        ...
    @property
    def logger(self) -> Logger:
        ...
    def init_callback(self, model: "base_class.BaseAlgorithm") -> None:
        ...
    def _init_callback(self) -> None:
        ...
    def on_training_start(self, locals_: dict[str, Any], globals_: dict[str, Any]) -> None:
        ...
    def _on_training_start(self) -> None:
        ...
    def on_rollout_start(self) -> None:
        ...
    def _on_rollout_start(self) -> None:
        ...
    @abstractmethod
    def _on_step(self) -> bool:
        ...
    def on_step(self) -> bool:
        ...
    def on_training_end(self) -> None:
        ...
    def _on_training_end(self) -> None:
        ...
    def on_rollout_end(self) -> None:
        ...
    def _on_rollout_end(self) -> None:
        ...
    def update_locals(self, locals_: dict[str, Any]) -> None:
        ...
    def update_child_locals(self, locals_: dict[str, Any]) -> None:
        ...
```

**Methods**:

- `__init__(verbose=0)`:
  - **Function**: Initialize callback with verbosity level
  - **Parameters**:
    - `verbose`: Verbosity level: 0 for no output, 1 for info messages, 2 for debug messages

- `training_env`:
  - **Function**: Get training environment property
  - **Return Value**: VecEnv instance

- `logger`:
  - **Function**: Get logger property
  - **Return Value**: Logger instance

- `init_callback(model)`:
  - **Function**: Initialize callback with model reference
  - **Parameters**:
    - `model`: RL model instance

- `on_training_start(locals_, globals_)`:
  - **Function**: Called when training starts
  - **Parameters**:
    - `locals_`: Local variables
    - `globals_`: Global variables

- `on_rollout_start()`:
  - **Function**: Called when rollout starts

- `on_step()`:
  - **Function**: Called after each env.step()
  - **Return Value**: False to abort training early

- `on_training_end()`:
  - **Function**: Called when training ends

- `on_rollout_end()`:
  - **Function**: Called when rollout ends

- `update_locals(locals_)`:
  - **Function**: Update local variables reference
  - **Parameters**:
    - `locals_`: Local variables during rollout

- `update_child_locals(locals_)`:
  - **Function**: Update local variables on sub callbacks
  - **Parameters**:
    - `locals_`: Local variables during rollout

#### 26. `EventCallback` Class - Base class for triggering callback on event

**Function**: Base class for callbacks that trigger other callbacks on specific events.

**Class Definition**:
```python
class EventCallback(BaseCallback):
    def __init__(self, callback: Optional[BaseCallback] = None, verbose: int = 0):
        ...
    def init_callback(self, model: "base_class.BaseAlgorithm") -> None:
        ...
    def _on_training_start(self) -> None:
        ...
    def _on_event(self) -> bool:
        ...
    def _on_step(self) -> bool:
        ...
    def update_child_locals(self, locals_: dict[str, Any]) -> None:
        ...
```

**Methods**:

- `__init__(callback=None, verbose=0)`:
  - **Function**: Initialize event callback
  - **Parameters**:
    - `callback`: Callback to trigger when event occurs

- `_on_event()`:
  - **Function**: Trigger the child callback
  - **Return Value**: Result from child callback's on_step()

#### 27. `CallbackList` Class - Class for chaining callbacks

**Function**: Class for chaining multiple callbacks and calling them sequentially.

**Class Definition**:
```python
class CallbackList(BaseCallback):
    def __init__(self, callbacks: list[BaseCallback]):
        ...
    def _init_callback(self) -> None:
        ...
    def _on_training_start(self) -> None:
        ...
    def _on_rollout_start(self) -> None:
        ...
    def _on_step(self) -> bool:
        ...
    def _on_rollout_end(self) -> None:
        ...
    def _on_training_end(self) -> None:
        ...
    def update_child_locals(self, locals_: dict[str, Any]) -> None:
        ...
```

**Methods**:

- `__init__(callbacks)`:
  - **Function**: Initialize callback list
  - **Parameters**:
    - `callbacks`: List of callbacks to chain

- `_on_step()`:
  - **Function**: Call on_step for all callbacks in sequence
  - **Return Value**: False if any callback returns False

#### 28. `CheckpointCallback` Class - Callback for saving model checkpoints

**Function**: Callback for saving a model every specified number of steps.

**Class Definition**:
```python
class CheckpointCallback(BaseCallback):
    def __init__(
        self,
        save_freq: int,
        save_path: str,
        name_prefix: str = "rl_model",
        save_replay_buffer: bool = False,
        save_vecnormalize: bool = False,
        verbose: int = 0,
    ):
        ...
    def _init_callback(self) -> None:
        ...
    def _checkpoint_path(self, checkpoint_type: str = "", extension: str = "") -> str:
        ...
    def _on_step(self) -> bool:
        ...
```

**Methods**:

- `__init__(save_freq, save_path, name_prefix="rl_model", save_replay_buffer=False, save_vecnormalize=False, verbose=0)`:
  - **Function**: Initialize checkpoint callback
  - **Parameters**:
    - `save_freq`: Save checkpoints every N calls
    - `save_path`: Path to save folder
    - `name_prefix`: Common prefix for saved models
    - `save_replay_buffer`: Whether to save replay buffer
    - `save_vecnormalize`: Whether to save VecNormalize statistics

- `_checkpoint_path(checkpoint_type="", extension="")`:
  - **Function**: Helper to get checkpoint path
  - **Parameters**:
    - `checkpoint_type`: "replay_buffer_" or "vecnormalize_" for other checkpoints
    - `extension`: File extension
  - **Return Value**: Checkpoint path

- `_on_step()`:
  - **Function**: Save checkpoints at specified frequency
  - **Return Value**: Always True

#### 29. `ConvertCallback` Class - Convert functional callback to object

**Function**: Convert functional callback (old-style) to object-oriented callback.

**Class Definition**:
```python
class ConvertCallback(BaseCallback):
  """
    Convert functional callback (old-style) to object.

    :param callback:
    :param verbose: Verbosity level: 0 for no output, 1 for info messages, 2 for debug messages
    """

    def __init__(self, callback: Optional[Callable[[dict[str, Any], dict[str, Any]], bool]], verbose: int = 0):
        ...
    def _on_step(self) -> bool:
        ...
```

**Methods**:

- `__init__(callback, verbose=0)`:
  - **Function**: Initialize convert callback
  - **Parameters**:
    - `callback`: Functional callback to convert

- `_on_step()`:
  - **Function**: Call the functional callback
  - **Return Value**: Result from functional callback

#### 30. `EvalCallback` Class - Callback for evaluating an agent

**Function**: Callback for evaluating an agent during training and saving best model.

**Class Definition**:
```python
class EvalCallback(EventCallback):
    def __init__(
        self,
        eval_env: Union[gym.Env, VecEnv],
        callback_on_new_best: Optional[BaseCallback] = None,
        callback_after_eval: Optional[BaseCallback] = None,
        n_eval_episodes: int = 5,
        eval_freq: int = 10000,
        log_path: Optional[str] = None,
        best_model_save_path: Optional[str] = None,
        deterministic: bool = True,
        render: bool = False,
        verbose: int = 1,
        warn: bool = True,
    ):
        ...
    def _init_callback(self) -> None:
        ...
    def _log_success_callback(self, locals_: dict[str, Any], globals_: dict[str, Any]) -> None:
        ...
    def _on_step(self) -> bool:
        ...
    def update_child_locals(self, locals_: dict[str, Any]) -> None:
        ...
```

**Methods**:

- `__init__(eval_env, callback_on_new_best=None, callback_after_eval=None, n_eval_episodes=5, eval_freq=10000, log_path=None, best_model_save_path=None, deterministic=True, render=False, verbose=1, warn=True)`:
  - **Function**: Initialize evaluation callback
  - **Parameters**:
    - `eval_env`: Environment for evaluation
    - `callback_on_new_best`: Callback for new best model
    - `callback_after_eval`: Callback after every evaluation
    - `n_eval_episodes`: Number of evaluation episodes
    - `eval_freq`: Evaluation frequency
    - `log_path`: Path for evaluation logs
    - `best_model_save_path`: Path for saving best model
    - `deterministic`: Use deterministic actions
    - `render`: Render during evaluation
    - `warn`: Warn about Monitor wrapper

- `_log_success_callback(locals_, globals_)`:
  - **Function**: Callback to log success rate
  - **Parameters**:
    - `locals_`: Local variables
    - `globals_`: Global variables

- `_on_step()`:
  - **Function**: Perform evaluation at specified frequency
  - **Return Value**: Whether to continue training

#### 31. `StopTrainingOnRewardThreshold` Class - Stop training on reward threshold

**Function**: Stop training once a reward threshold is reached, used with EvalCallback.

**Class Definition**:
```python
class StopTrainingOnRewardThreshold(BaseCallback):
    def __init__(self, reward_threshold: float, verbose: int = 0):
        ...
    def _on_step(self) -> bool:
        ...
```

**Methods**:

- `__init__(reward_threshold, verbose=0)`:
  - **Function**: Initialize reward threshold callback
  - **Parameters**:
    - `reward_threshold`: Minimum expected reward to stop training

- `_on_step()`:
  - **Function**: Check if reward threshold is reached
  - **Return Value**: Whether to continue training

#### 32. `EveryNTimesteps` Class - Trigger callback every N timesteps

**Function**: Trigger a callback every specified number of timesteps.

**Class Definition**:
```python
class EveryNTimesteps(EventCallback):
    def __init__(self, n_steps: int, callback: BaseCallback):
        ...
    def _on_step(self) -> bool:
        ...
```

**Methods**:

- `__init__(n_steps, callback)`:
  - **Function**: Initialize N timesteps callback
  - **Parameters**:
    - `n_steps`: Number of timesteps between triggers
    - `callback`: Callback to trigger

- `_on_step()`:
  - **Function**: Trigger callback every N steps
  - **Return Value**: Result from triggered callback

#### 33. `LogEveryNTimesteps` Class - Log data every N timesteps

**Function**: Log data every specified number of timesteps.

**Class Definition**:
```python
class LogEveryNTimesteps(EveryNTimesteps):
    def __init__(self, n_steps: int):
        ...
    def _log_data(self, _locals: dict[str, Any], _globals: dict[str, Any]) -> bool:
        ...
```

**Methods**:

- `__init__(n_steps)`:
  - **Function**: Initialize log callback
  - **Parameters**:
    - `n_steps`: Number of timesteps between logs

- `_log_data(_locals, _globals)`:
  - **Function**: Dump model logs
  - **Return Value**: Always True

#### 34. `StopTrainingOnMaxEpisodes` Class - Stop training on max episodes

**Function**: Stop training once maximum number of episodes is reached.

**Class Definition**:
```python
class StopTrainingOnMaxEpisodes(BaseCallback):
    """
    Stop the training once a maximum number of episodes are played.

    For multiple environments presumes that, the desired behavior is that the agent trains on each env for ``max_episodes``
    and in total for ``max_episodes * n_envs`` episodes.

    :param max_episodes: Maximum number of episodes to stop training.
    :param verbose: Verbosity level: 0 for no output, 1 for indicating information about when training ended by
        reaching ``max_episodes``
    """
    def __init__(self, max_episodes: int, verbose: int = 0):
        ...
    def _init_callback(self) -> None:
        ...
    def _on_step(self) -> bool:
        ...
```

**Methods**:

- `__init__(max_episodes, verbose=0)`:
  - **Function**: Initialize max episodes callback
  - **Parameters**:
    - `max_episodes`: Maximum number of episodes

- `_on_step()`:
  - **Function**: Check episode count and stop if max reached
  - **Return Value**: Whether to continue training

#### 35. `StopTrainingOnNoModelImprovement` Class - Stop training on no improvement

**Function**: Stop training if no model improvement after consecutive evaluations.

**Class Definition**:
```python
class StopTrainingOnNoModelImprovement(BaseCallback):
  """
    Stop the training early if there is no new best model (new best mean reward) after more than N consecutive evaluations.

    It is possible to define a minimum number of evaluations before start to count evaluations without improvement.

    It must be used with the ``EvalCallback``.

    :param max_no_improvement_evals: Maximum number of consecutive evaluations without a new best model.
    :param min_evals: Number of evaluations before start to count evaluations without improvements.
    :param verbose: Verbosity level: 0 for no output, 1 for indicating when training ended because no new best model
    """
    def __init__(self, max_no_improvement_evals: int, min_evals: int = 0, verbose: int = 0):
        ...
    def _on_step(self) -> bool:
        ...
```

**Methods**:

- `__init__(max_no_improvement_evals, min_evals=0, verbose=0)`:
  - **Function**: Initialize no improvement callback
  - **Parameters**:
    - `max_no_improvement_evals`: Max consecutive evals without improvement
    - `min_evals`: Minimum evals before counting

- `_on_step()`:
  - **Function**: Check for model improvement
  - **Return Value**: Whether to continue training

#### 36. `ProgressBarCallback` Class - Display training progress bar

**Function**: Display a progress bar during training using tqdm and rich.

**Class Definition**:
```python
class ProgressBarCallback(BaseCallback):
  """
  Display a progress bar when training SB3 agent
  using tqdm and rich packages.
  """
  pbar: tqdm

  def __init__(self) -> None:
      ...
  def _on_training_start(self) -> None:
      ...
  def _on_step(self) -> bool:
      ...
  def _on_training_end(self) -> None:
      ...
```

**Methods**:

- `_on_training_start()`:
  - **Function**: Initialize progress bar

- `_on_step()`:
  - **Function**: Update progress bar
  - **Return Value**: Always True

- `_on_training_end()`:
  - **Function**: Close progress bar

#### 37. `Distribution` Class - Abstract base class for distributions

**Function**: Abstract base class for probability distributions used in policy networks.

**Class Definition**:
```python
class Distribution(ABC):
  """Abstract base class for distributions."""
    def __init__(self):
        ...
    @abstractmethod
    def proba_distribution_net(self, *args, **kwargs) -> Union[nn.Module, tuple[nn.Module, nn.Parameter]]:
        ...
    @abstractmethod
    def proba_distribution(self: SelfDistribution, *args, **kwargs) -> SelfDistribution:
        ...
    @abstractmethod
    def log_prob(self, x: th.Tensor) -> th.Tensor:
        ...
    @abstractmethod
    def entropy(self) -> Optional[th.Tensor]:
        ...
    @abstractmethod
    def sample(self) -> th.Tensor:
        ...
    @abstractmethod
    def mode(self) -> th.Tensor:
        ...
    def get_actions(self, deterministic: bool = False) -> th.Tensor:
        ...
    @abstractmethod
    def actions_from_params(self, *args, **kwargs) -> th.Tensor:
        ...
    @abstractmethod
    def log_prob_from_params(self, *args, **kwargs) -> tuple[th.Tensor, th.Tensor]:
        ...
```

**Methods**:

- `proba_distribution_net(*args, **kwargs)`:
  - **Function**: Create layers and parameters representing the distribution (abstract)
  - **Return Value**: Neural network module or tuple of module and parameter

- `proba_distribution(*args, **kwargs)`:
  - **Function**: Set parameters of the distribution (abstract)
  - **Return Value**: Self

- `log_prob(x)`:
  - **Function**: Compute log likelihood of actions (abstract)
  - **Parameters**:
    - `x`: Taken action
  - **Return Value**: Log likelihood

- `entropy()`:
  - **Function**: Compute Shannon's entropy (abstract)
  - **Return Value**: Entropy tensor or None

- `sample()`:
  - **Function**: Sample from probability distribution (abstract)
  - **Return Value**: Stochastic action

- `mode()`:
  - **Function**: Get most likely action (abstract)
  - **Return Value**: Deterministic action

- `get_actions(deterministic=False)`:
  - **Function**: Return actions according to probability distribution
  - **Parameters**:
    - `deterministic`: Whether to return deterministic action
  - **Return Value**: Action tensor

- `actions_from_params(*args, **kwargs)`:
  - **Function**: Sample actions given distribution parameters (abstract)
  - **Return Value**: Actions

- `log_prob_from_params(*args, **kwargs)`:
  - **Function**: Get samples and log probabilities from parameters (abstract)
  - **Return Value**: Tuple of actions and log probabilities

#### 38. `sum_independent_dims` Function - Sum independent dimensions

**Function**: Sum components of log_prob or entropy for independent continuous actions.

**Function Signature**:
```python
def sum_independent_dims(tensor: th.Tensor) -> th.Tensor
```

**Parameter Description**:
- `tensor`: Input tensor of shape (n_batch, n_actions) or (n_batch,)

**Return Value**: Tensor of shape (n_batch,) or scalar

#### 39. `DiagGaussianDistribution` Class - Gaussian distribution with diagonal covariance

**Function**: Gaussian distribution with diagonal covariance matrix for continuous actions.

**Class Definition**:
```python
class DiagGaussianDistribution(Distribution):
    def __init__(self, action_dim: int):
        ...
    def proba_distribution_net(self, latent_dim: int, log_std_init: float = 0.0) -> tuple[nn.Module, nn.Parameter]:
        ...
    def proba_distribution(
        self: SelfDiagGaussianDistribution, mean_actions: th.Tensor, log_std: th.Tensor
    ) -> SelfDiagGaussianDistribution:
        ...
    def log_prob(self, actions: th.Tensor) -> th.Tensor:
        ...
    def entropy(self) -> Optional[th.Tensor]:
        ...
    def sample(self) -> th.Tensor:
        ...
    def mode(self) -> th.Tensor:
        ...
    def actions_from_params(self, mean_actions: th.Tensor, log_std: th.Tensor, deterministic: bool = False) -> th.Tensor:
        ...
    def log_prob_from_params(self, mean_actions: th.Tensor, log_std: th.Tensor) -> tuple[th.Tensor, th.Tensor]:
        ...
```

**Methods**:

- `__init__(action_dim)`:
  - **Function**: Initialize diagonal Gaussian distribution
  - **Parameters**:
    - `action_dim`: Dimension of action space

- `proba_distribution_net(latent_dim, log_std_init=0.0)`:
  - **Function**: Create mean and log_std network layers
  - **Parameters**:
    - `latent_dim`: Dimension of last policy layer
    - `log_std_init`: Initial log standard deviation value
  - **Return Value**: Tuple of mean actions layer and log_std parameter

- `proba_distribution(mean_actions, log_std)`:
  - **Function**: Create distribution with given parameters
  - **Parameters**:
    - `mean_actions`: Mean actions tensor
    - `log_std`: Log standard deviation tensor
  - **Return Value**: Self

- `log_prob(actions)`:
  - **Function**: Compute log probability of actions
  - **Parameters**:
    - `actions`: Actions tensor
  - **Return Value**: Summed log probabilities

- `sample()`:
  - **Function**: Sample using reparameterization trick
  - **Return Value**: Sampled actions

#### 40. `SquashedDiagGaussianDistribution` Class - Squashed Gaussian distribution

**Function**: Gaussian distribution followed by tanh squashing to ensure bounds.

**Class Definition**:
```python
class SquashedDiagGaussianDistribution(DiagGaussianDistribution):
  """
  Gaussian distribution with diagonal covariance matrix, followed by a squashing function (tanh) to ensure bounds.

  :param action_dim: Dimension of the action space.
  :param epsilon: small value to avoid NaN due to numerical imprecision.
  """

  def __init__(self, action_dim: int, epsilon: float = 1e-6):
      ...
  def proba_distribution(
      self: SelfSquashedDiagGaussianDistribution, mean_actions: th.Tensor, log_std: th.Tensor
  ) -> SelfSquashedDiagGaussianDistribution:
      ...
  def log_prob(self, actions: th.Tensor, gaussian_actions: Optional[th.Tensor] = None) -> th.Tensor:
      ...
  def entropy(self) -> Optional[th.Tensor]:
      ...
  def sample(self) -> th.Tensor:
      ...
  def mode(self) -> th.Tensor:
      ...
  def log_prob_from_params(self, mean_actions: th.Tensor, log_std: th.Tensor) -> tuple[th.Tensor, th.Tensor]:
      ...
```

**Methods**:

- `__init__(action_dim, epsilon=1e-6)`:
  - **Function**: Initialize squashed Gaussian distribution
  - **Parameters**:
    - `action_dim`: Dimension of action space
    - `epsilon`: Small value to avoid NaN

- `log_prob(actions, gaussian_actions=None)`:
  - **Function**: Compute log probability with squash correction
  - **Parameters**:
    - `actions`: Squashed actions
    - `gaussian_actions`: Pre-computed Gaussian actions
  - **Return Value**: Log probability with correction

- `sample()`:
  - **Function**: Sample and apply tanh squashing
  - **Return Value**: Squashed actions

#### 41. `CategoricalDistribution` Class - Categorical distribution for discrete actions

**Function**: Categorical distribution for discrete action spaces.

**Class Definition**:
```python
class CategoricalDistribution(Distribution):
    def __init__(self, action_dim: int):
        ...
    def proba_distribution_net(self, latent_dim: int) -> nn.Module:
        ...
    def proba_distribution(self: SelfCategoricalDistribution, action_logits: th.Tensor) -> SelfCategoricalDistribution:
        ...
    def log_prob(self, actions: th.Tensor) -> th.Tensor:
        ...
    def entropy(self) -> th.Tensor:
        ...
    def sample(self) -> th.Tensor:
        ...
    def mode(self) -> th.Tensor:
        ...
    def actions_from_params(self, action_logits: th.Tensor, deterministic: bool = False) -> th.Tensor:
        ...
    def log_prob_from_params(self, action_logits: th.Tensor) -> tuple[th.Tensor, th.Tensor]:
        ...
```

**Methods**:

- `__init__(action_dim)`:
  - **Function**: Initialize categorical distribution
  - **Parameters**:
    - `action_dim`: Number of discrete actions

- `proba_distribution_net(latent_dim)`:
  - **Function**: Create action logits layer
  - **Parameters**:
    - `latent_dim`: Dimension of last policy layer
  - **Return Value**: Action logits layer

- `proba_distribution(action_logits)`:
  - **Function**: Create distribution from logits
  - **Parameters**:
    - `action_logits`: Action logits tensor
  - **Return Value**: Self

- `mode()`:
  - **Function**: Get action with highest probability
  - **Return Value**: Deterministic action

#### 42. `MultiCategoricalDistribution` Class - MultiCategorical distribution for multi-discrete actions

**Function**: MultiCategorical distribution for multi-discrete action spaces.

**Class Definition**:
```python
class MultiCategoricalDistribution(Distribution):
  """
  MultiCategorical distribution for multi discrete actions.

  :param action_dims: List of sizes of discrete action spaces
  """
  def __init__(self, action_dims: list[int]):
      ...
  def proba_distribution_net(self, latent_dim: int) -> nn.Module:
      ...
  def proba_distribution(
      self: SelfMultiCategoricalDistribution, action_logits: th.Tensor
  ) -> SelfMultiCategoricalDistribution:
      ...
  def log_prob(self, actions: th.Tensor) -> th.Tensor:
      ...
  def entropy(self) -> th.Tensor:
      ...
  def sample(self) -> th.Tensor:
      ...
  def mode(self) -> th.Tensor:
      ...
  def actions_from_params(self, action_logits: th.Tensor, deterministic: bool = False) -> th.Tensor:
      ...
  def log_prob_from_params(self, action_logits: th.Tensor) -> tuple[th.Tensor, th.Tensor]:
      ...
```

**Methods**:

- `__init__(action_dims)`:
  - **Function**: Initialize multi-categorical distribution
  - **Parameters**:
    - `action_dims`: List of sizes of discrete action spaces

- `proba_distribution_net(latent_dim)`:
  - **Function**: Create flattened logits layer
  - **Parameters**:
    - `latent_dim`: Dimension of last policy layer
  - **Return Value**: Action logits layer

- `proba_distribution(action_logits)`:
  - **Function**: Split logits and create multiple categorical distributions
  - **Parameters**:
    - `action_logits`: Flattened action logits
  - **Return Value**: Self

- `log_prob(actions)`:
  - **Function**: Compute summed log probability across action dimensions
  - **Parameters**:
    - `actions`: Multi-dimensional actions
  - **Return Value**: Summed log probabilities

#### 43. `BernoulliDistribution` Class - Bernoulli distribution for binary actions

**Function**: Bernoulli distribution for MultiBinary action spaces.

**Class Definition**:
```python
class BernoulliDistribution(Distribution):
  """
  Bernoulli distribution for MultiBinary action spaces.

  :param action_dim: Number of binary actions
  """
  def __init__(self, action_dims: int):
      ...
  def proba_distribution_net(self, latent_dim: int) -> nn.Module:
      ...
  def proba_distribution(self: SelfBernoulliDistribution, action_logits: th.Tensor) -> SelfBernoulliDistribution:
      ...
  def log_prob(self, actions: th.Tensor) -> th.Tensor:
      ...
  def entropy(self) -> th.Tensor:
      ...
  def sample(self) -> th.Tensor:
      ...
  def mode(self) -> th.Tensor:
      ...
  def actions_from_params(self, action_logits: th.Tensor, deterministic: bool = False) -> th.Tensor:
      ...
  def log_prob_from_params(self, action_logits: th.Tensor) -> tuple[th.Tensor, th.Tensor]:
      ...
```

**Methods**:

- `__init__(action_dims)`:
  - **Function**: Initialize Bernoulli distribution
  - **Parameters**:
    - `action_dims`: Number of binary actions

- `mode()`:
  - **Function**: Get rounded probabilities as actions
  - **Return Value**: Binary actions

#### 44. `StateDependentNoiseDistribution` Class - Distribution for state-dependent exploration

**Function**: Distribution class for generalized State Dependent Exploration (gSDE).

**Class Definition**:
```python
class StateDependentNoiseDistribution(Distribution):
    def __init__(
        self,
        action_dim: int,
        full_std: bool = True,
        use_expln: bool = False,
        squash_output: bool = False,
        learn_features: bool = False,
        epsilon: float = 1e-6,
    ):
        ...
    def get_std(self, log_std: th.Tensor) -> th.Tensor:
        ...
    def sample_weights(self, log_std: th.Tensor, batch_size: int = 1) -> None:
        ...
    def proba_distribution_net(
        self, latent_dim: int, log_std_init: float = -2.0, latent_sde_dim: Optional[int] = None
    ) -> tuple[nn.Module, nn.Parameter]:
        ...
    def proba_distribution(
        self: SelfStateDependentNoiseDistribution, mean_actions: th.Tensor, log_std: th.Tensor, latent_sde: th.Tensor
    ) -> SelfStateDependentNoiseDistribution:
        ...
    def log_prob(self, actions: th.Tensor) -> th.Tensor:
        ...
    def entropy(self) -> Optional[th.Tensor]:
        ...
    def sample(self) -> th.Tensor:
        ...
    def mode(self) -> th.Tensor:
        ...
    def get_noise(self, latent_sde: th.Tensor) -> th.Tensor:
        ...
    def actions_from_params(
        self, mean_actions: th.Tensor, log_std: th.Tensor, latent_sde: th.Tensor, deterministic: bool = False
    ) -> th.Tensor:
        ...
    def log_prob_from_params(
        self, mean_actions: th.Tensor, log_std: th.Tensor, latent_sde: th.Tensor
    ) -> tuple[th.Tensor, th.Tensor]:
        ...
```

**Methods**:

- `__init__(action_dim, full_std=True, use_expln=False, squash_output=False, learn_features=False, epsilon=1e-6)`:
  - **Function**: Initialize state-dependent noise distribution
  - **Parameters**:
    - `action_dim`: Action space dimension
    - `full_std`: Use (n_features x n_actions) parameters
    - `use_expln`: Use expln function for positive std
    - `squash_output`: Apply tanh squashing
    - `learn_features`: Learn features for gSDE
    - `epsilon`: Small value to avoid NaN

- `get_std(log_std)`:
  - **Function**: Get standard deviation from learned parameter
  - **Parameters**:
    - `log_std`: Log standard deviation
  - **Return Value**: Standard deviation tensor

- `sample_weights(log_std, batch_size=1)`:
  - **Function**: Sample weights for noise exploration matrix
  - **Parameters**:
    - `log_std`: Log standard deviation
    - `batch_size`: Batch size for parallel exploration

- `get_noise(latent_sde)`:
  - **Function**: Compute noise using latent features and exploration matrix
  - **Parameters**:
    - `latent_sde`: Latent features
  - **Return Value**: Noise tensor

#### 45. `TanhBijector` Class - Bijective transformation using tanh

**Function**: Bijective transformation using tanh squashing function.

**Class Definition**:
```python
class TanhBijector:
  """
  Bijective transformation of a probability distribution
  using a squashing function (tanh)

  :param epsilon: small value to avoid NaN due to numerical imprecision.
  """
  def __init__(self, epsilon: float = 1e-6):
      ...
  @staticmethod
  def forward(x: th.Tensor) -> th.Tensor:
      ...
  @staticmethod
  def atanh(x: th.Tensor) -> th.Tensor:
      ...
  @staticmethod
  def inverse(y: th.Tensor) -> th.Tensor:
      ...
  def log_prob_correction(self, x: th.Tensor) -> th.Tensor:
      ...
```

**Methods**:

- `forward(x)`:
  - **Function**: Apply tanh transformation
  - **Parameters**:
    - `x`: Input tensor
  - **Return Value**: Tanh-transformed tensor

- `inverse(y)`:
  - **Function**: Inverse tanh transformation
  - **Parameters**:
    - `y`: Tanh-transformed tensor
  - **Return Value**: Original tensor

- `log_prob_correction(x)`:
  - **Function**: Compute log probability correction for squashing
  - **Parameters**:
    - `x`: Input tensor
  - **Return Value**: Log probability correction

#### 46. `make_proba_distribution` Function - Create distribution for action space

**Function**: Create appropriate Distribution instance for given action space.

**Function Signature**:
```python
def make_proba_distribution(
    action_space: spaces.Space, use_sde: bool = False, dist_kwargs: Optional[dict[str, Any]] = None
) -> Distribution:
  """
  Return an instance of Distribution for the correct type of action space

  :param action_space: the input action space
  :param use_sde: Force the use of StateDependentNoiseDistribution
      instead of DiagGaussianDistribution
  :param dist_kwargs: Keyword arguments to pass to the probability distribution
  :return: the appropriate Distribution object
  """
```

**Parameter Description**:
- `action_space`: Input action space
- `use_sde`: Force use of StateDependentNoiseDistribution
- `dist_kwargs`: Keyword arguments for distribution

**Return Value**: Appropriate Distribution object

#### 47. `kl_divergence` Function - Compute KL divergence between distributions

**Function**: Compute KL divergence between two probability distributions.

**Function Signature**:
```python
def kl_divergence(dist_true: Distribution, dist_pred: Distribution) -> th.Tensor
```

**Parameter Description**:
- `dist_true`: The p distribution
- `dist_pred`: The q distribution

**Return Value**: KL(dist_true||dist_pred) tensor

#### 48. `_is_oneof_space` Function - Check if space is OneOf space

**Function**: Return True if the provided space is a OneOf space, False if not or if the current version of Gym doesn't support this space.

**Function Signature**:
```python
def _is_oneof_space(space: spaces.Space) -> bool
```

**Parameter Description**:
- `space`: Gym space to check

**Return Value**: Boolean indicating if space is OneOf type

#### 49. `_is_numpy_array_space` Function - Check if space is representable as numpy array

**Function**: Returns False if provided space is not representable as a single numpy array (e.g. Dict and Tuple spaces return False).

**Function Signature**:
```python
def _is_numpy_array_space(space: spaces.Space) -> bool:
  """
  Returns False if provided space is not representable as a single numpy array
  (e.g. Dict and Tuple spaces return False)
  """
```

**Parameter Description**:
- `space`: Gym space to check

**Return Value**: Boolean indicating if space can be represented as numpy array

#### 50. `_starts_at_zero` Function - Check if discrete space starts at zero

**Function**: Return False if a (Multi)Discrete space has a non-zero start.

**Function Signature**:
```python
def _starts_at_zero(space: Union[spaces.Discrete, spaces.MultiDiscrete]) -> bool
```

**Parameter Description**:
- `space`: Discrete or MultiDiscrete space to check

**Return Value**: Boolean indicating if space starts at zero

#### 51. `_check_non_zero_start` Function - Check for non-zero start in discrete spaces

**Function**: Check and warn about non-zero start in discrete observation or action spaces.

**Function Signature**:
```python
def _check_non_zero_start(space: spaces.Space, space_type: str = "observation", key: str = "") -> None:
  """
  :param space: Observation or action space
  :param space_type: information about whether it is an observation or action space
      (for the warning message)
  :param key: When the observation space comes from a Dict space, we pass the
      corresponding key to have more precise warning messages. Defaults to "".
  """
```

**Parameter Description**:
- `space`: Observation or action space
- `space_type`: Type of space ("observation" or "action")
- `key`: Key for Dict spaces for precise warning messages

#### 52. `_check_image_input` Function - Check image observation compatibility

**Function**: Check that the input will be compatible with Stable-Baselines when the observation is apparently an image.

**Function Signature**:
```python
def _check_image_input(observation_space: spaces.Box, key: str = "") -> None
```

**Parameter Description**:
- `observation_space`: Image observation space
- `key`: Key for Dict spaces for precise warning messages

#### 53. `_check_unsupported_spaces` Function - Check for unsupported space types

**Function**: Emit warnings when the observation space or action space used is not supported by Stable-Baselines.

**Function Signature**:
```python
def _check_unsupported_spaces(env: gym.Env, observation_space: spaces.Space, action_space: spaces.Space) -> bool:
  """
  Emit warnings when the observation space or action space used is not supported by Stable-Baselines.

  :return: True if return value tests should be skipped.
  """
```

**Parameter Description**:
- `env`: Gym environment
- `observation_space`: Observation space
- `action_space`: Action space

**Return Value**: True if return value tests should be skipped

#### 54. `_check_nan` Function - Check for NaN values

**Function**: Check for Inf and NaN using the VecWrapper.

**Function Signature**:
```python
def _check_nan(env: gym.Env) -> None:
  """Check for Inf and NaN using the VecWrapper."""
```

**Parameter Description**:
- `env`: Gym environment to check

#### 55. `_is_goal_env` Function - Check if environment is goal-conditioned

**Function**: Check if the env uses the convention for goal-conditioned envs (previously, the gym.GoalEnv interface).

**Function Signature**:
```python
def _is_goal_env(env: gym.Env) -> bool:
  """
  Check if the env uses the convention for goal-conditioned envs (previously, the gym.GoalEnv interface)
  """
```

**Parameter Description**:
- `env`: Gym environment to check

**Return Value**: Boolean indicating if environment is goal-conditioned

#### 56. `_check_goal_env_obs` Function - Check goal environment observation structure

**Function**: Check that an environment implementing the `compute_rewards()` method contains required observation keys.

**Function Signature**:
```python
def _check_goal_env_obs(obs: dict, observation_space: spaces.Dict, method_name: str) -> None:
  """
  Check that an environment implementing the `compute_rewards()` method
  (previously known as GoalEnv in gym) contains at least three elements,
  namely `observation`, `achieved_goal`, and `desired_goal`.
  """
```

**Parameter Description**:
- `obs`: Observation dictionary
- `observation_space`: Dict observation space
- `method_name`: Name of method being checked ("reset" or "step")

#### 57. `_check_goal_env_compute_reward` Function - Check goal environment reward computation

**Function**: Check that reward is computed with `compute_reward` and that the implementation is vectorized.

**Function Signature**:
```python
def _check_goal_env_compute_reward(
    obs: dict[str, Union[np.ndarray, int]],
    env: gym.Env,
    reward: float,
    info: dict[str, Any],
) -> None:
  """
  Check that reward is computed with `compute_reward`
  and that the implementation is vectorized.
  """
```

**Parameter Description**:
- `obs`: Observation dictionary
- `env`: Goal environment
- `reward`: Computed reward
- `info`: Info dictionary

#### 58. `_check_obs` Function - Check observation validity

**Function**: Check that the observation returned by the environment correspond to the declared one.

**Function Signature**:
```python
def _check_obs(obs: Union[tuple, dict, np.ndarray, int], observation_space: spaces.Space, method_name: str) -> None:
  """
  Check that the observation returned by the environment
  correspond to the declared one.
  """
```

**Parameter Description**:
- `obs`: Returned observation
- `observation_space`: Declared observation space
- `method_name`: Name of method being checked ("reset" or "step")

#### 59. `_check_box_obs` Function - Check Box observation space formatting

**Function**: Check that the observation space is correctly formatted when dealing with a Box space.

**Function Signature**:
```python
def _check_box_obs(observation_space: spaces.Box, key: str = "") -> None:
  """
  Check that the observation space is correctly formatted
  when dealing with a ``Box()`` space. In particular, it checks:
  - that the dimensions are big enough when it is an image, and that the type matches
  - that the observation has an expected shape (warn the user if not)
  """
```

**Parameter Description**:
- `observation_space`: Box observation space
- `key`: Key for Dict spaces for precise warning messages

#### 60. `_check_returned_values` Function - Check environment return values

**Function**: Check the returned values by the env when calling `.reset()` or `.step()` methods.

**Function Signature**:
```python
def _check_returned_values(env: gym.Env, observation_space: spaces.Space, action_space: spaces.Space) -> None:
  """
  Check the returned values by the env when calling `.reset()` or `.step()` methods.
  """
```

**Parameter Description**:
- `env`: Gym environment
- `observation_space`: Observation space
- `action_space`: Action space

#### 61. `_check_spaces` Function - Check space definitions

**Function**: Check that the observation and action spaces are defined and inherit from spaces.Space.

**Function Signature**:
```python
def _check_spaces(env: gym.Env) -> None:
  """
  Check that the observation and action spaces are defined and inherit from spaces.Space. For
  envs that follow the goal-conditioned standard (previously, the gym.GoalEnv interface) we check
  the observation space is gymnasium.spaces.Dict
  """
```

**Parameter Description**:
- `env`: Gym environment

#### 62. `_check_render` Function - Check render method

**Function**: Check the instantiated render mode (if any) by calling the `render()`/`close()` method.

**Function Signature**:
```python
def _check_render(env: gym.Env, warn: bool = False) -> None:
  """
  Check the instantiated render mode (if any) by calling the `render()`/`close()`
  method of the environment.

  :param env: The environment to check
  :param warn: Whether to output additional warnings
  :param headless: Whether to disable render modes
      that require a graphical interface. False by default.
  """
```

**Parameter Description**:
- `env`: Gym environment
- `warn`: Whether to output additional warnings

#### 63. `check_env` Function - Main environment validation function

**Function**: Check that an environment follows Gym API and is compatible with Stable-Baselines.

**Function Signature**:
```python
def check_env(env: gym.Env, warn: bool = True, skip_render_check: bool = True) -> None:
  """
  Check that an environment follows Gym API.
  This is particularly useful when using a custom environment.
  Please take a look at https://gymnasium.farama.org/api/env/
  for more information about the API.

  It also optionally check that the environment is compatible with Stable-Baselines.

  :param env: The Gym environment that will be checked
  :param warn: Whether to output additional warnings
      mainly related to the interaction with Stable Baselines
  :param skip_render_check: Whether to skip the checks for the render method.
      True by default (useful for the CI)
  """
```

**Parameter Description**:
- `env`: The Gym environment that will be checked
- `warn`: Whether to output additional warnings
- `skip_render_check`: Whether to skip render method checks

#### 64. `unwrap_wrapper` Function - Recursively retrieve wrapper

**Function**: Retrieve a wrapper object by recursively searching through the environment wrapper chain.

**Function Signature**:
```python
def unwrap_wrapper(env: gym.Env, wrapper_class: type[gym.Wrapper]) -> Optional[gym.Wrapper]:
  """
    Retrieve a ``VecEnvWrapper`` object by recursively searching.

    :param env: Environment to unwrap
    :param wrapper_class: Wrapper to look for
    :return: Environment unwrapped till ``wrapper_class`` if it has been wrapped with it
    """
```

**Parameter Description**:
- `env`: Environment to unwrap
- `wrapper_class`: Wrapper class to look for

**Return Value**: Environment unwrapped till the specified wrapper class if found, None otherwise

#### 65. `is_wrapped` Function - Check if environment has wrapper

**Function**: Check if a given environment has been wrapped with a given wrapper.

**Function Signature**:
```python
def is_wrapped(env: gym.Env, wrapper_class: type[gym.Wrapper]) -> bool:
  """
  Check if a given environment has been wrapped with a given wrapper.

  :param env: Environment to check
  :param wrapper_class: Wrapper class to look for
  :return: True if environment has been wrapped with ``wrapper_class``.
  """
```

**Parameter Description**:
- `env`: Environment to check
- `wrapper_class`: Wrapper class to look for

**Return Value**: True if environment has been wrapped with the specified wrapper class

#### 66. `make_vec_env` Function - Create wrapped, monitored vectorized environment

**Function**: Create a wrapped, monitored VecEnv for parallel environment execution.

**Function Signature**:
```python
def make_vec_env(
    env_id: Union[str, Callable[..., gym.Env]],
    n_envs: int = 1,
    seed: Optional[int] = None,
    start_index: int = 0,
    monitor_dir: Optional[str] = None,
    wrapper_class: Optional[Callable[[gym.Env], gym.Env]] = None,
    env_kwargs: Optional[dict[str, Any]] = None,
    vec_env_cls: Optional[type[Union[DummyVecEnv, SubprocVecEnv]]] = None,
    vec_env_kwargs: Optional[dict[str, Any]] = None,
    monitor_kwargs: Optional[dict[str, Any]] = None,
    wrapper_kwargs: Optional[dict[str, Any]] = None,
) -> VecEnv
    def make_env(rank: int) -> Callable[[], gym.Env]
        def _init() -> gym.Env

```

**Parameter Description**:
- `env_id`: either the env ID, the env class or a callable returning an env
- `n_envs`: the number of environments you wish to have in parallel
- `seed`: the initial seed for the random number generator
- `start_index`: start rank index
- `monitor_dir`: Path to a folder where the monitor files will be saved
- `wrapper_class`: Additional wrapper to use on the environment
- `env_kwargs`: Optional keyword argument to pass to the env constructor
- `vec_env_cls`: A custom VecEnv class constructor
- `vec_env_kwargs`: Keyword arguments to pass to the VecEnv class constructor
- `monitor_kwargs`: Keyword arguments to pass to the Monitor class constructor
- `wrapper_kwargs`: Keyword arguments to pass to the Wrapper class constructor

**Return Value**: The wrapped vectorized environment

#### 67. `make_atari_env` Function - Create vectorized environment for Atari games

**Function**: Create a wrapped, monitored VecEnv for Atari games with common preprocessing.

**Function Signature**:
```python
def make_atari_env(
    env_id: Union[str, Callable[..., gym.Env]],
    n_envs: int = 1,
    seed: Optional[int] = None,
    start_index: int = 0,
    monitor_dir: Optional[str] = None,
    wrapper_kwargs: Optional[dict[str, Any]] = None,
    env_kwargs: Optional[dict[str, Any]] = None,
    vec_env_cls: Optional[Union[type[DummyVecEnv], type[SubprocVecEnv]]] = None,
    vec_env_kwargs: Optional[dict[str, Any]] = None,
    monitor_kwargs: Optional[dict[str, Any]] = None,
) -> VecEnv
```

**Parameter Description**:
- `env_id`: either the env ID, the env class or a callable returning an env
- `n_envs`: the number of environments you wish to have in parallel
- `seed`: the initial seed for the random number generator
- `start_index`: start rank index
- `monitor_dir`: Path to a folder where the monitor files will be saved
- `wrapper_kwargs`: Optional keyword argument to pass to the AtariWrapper
- `env_kwargs`: Optional keyword argument to pass to the env constructor
- `vec_env_cls`: A custom VecEnv class constructor
- `vec_env_kwargs`: Keyword arguments to pass to the VecEnv class constructor
- `monitor_kwargs`: Keyword arguments to pass to the Monitor class constructor

**Return Value**: The wrapped vectorized environment for Atari games


#### 68. `evaluate_policy` Function - Policy Performance Evaluation
**Function**: Evaluates a policy by running multiple episodes and computing performance metrics.

**Function Signature**:
```python
def evaluate_policy(
    model: "type_aliases.PolicyPredictor",
    env: Union[gym.Env, VecEnv],
    n_eval_episodes: int = 10,
    deterministic: bool = True,
    render: bool = False,
    callback: Optional[Callable[[dict[str, Any], dict[str, Any]], None]] = None,
    reward_threshold: Optional[float] = None,
    return_episode_rewards: bool = False,
    warn: bool = True,
) -> Union[tuple[float, float], tuple[list[float], list[int]]]:
```

**Parameter Description**:
- `model`: Policy or algorithm with `predict` method to evaluate
- `env`: Environment or vectorized environment for evaluation
- `n_eval_episodes`: Number of episodes to run for evaluation
- `deterministic`: Whether to use deterministic or stochastic actions
- `render`: Whether to render the environment during evaluation
- `callback`: Function called after each step for additional monitoring
- `reward_threshold`: Minimum expected reward to pass evaluation
- `return_episode_rewards`: Whether to return per-episode results or aggregates
- `warn`: Whether to warn about missing Monitor wrapper

**Return Value**:
- When `return_episode_rewards=False`: Tuple of (mean reward, standard deviation)
- When `return_episode_rewards=True`: Tuple of (list of episode rewards, list of episode lengths)

**Details**:
- Evenly distributes evaluation episodes across parallel environments
- Handles both single environments and vectorized environments
- Properly tracks episode boundaries in vectorized settings
- Supports callback functions for custom monitoring
- Validates performance against reward threshold if provided
- Automatically wraps single environments in DummyVecEnv
- Warns about potential monitoring issues with unwrapped environments

**Key Features**:
- Robust episode counting across parallel environments
- Support for both Monitor-wrapped and unwrapped environments
- Flexible return formats for different analysis needs
- Integration with both policy objects and algorithm instances
- Proper handling of deterministic vs stochastic action selection


#### 69. `Video` Class - Video data container

**Function**: Video data class storing the video frames and the frame per seconds.

**Class Definition**:
```python
class Video:
  """
  Video data class storing the video frames and the frame per seconds

  :param frames: frames to create the video from
  :param fps: frames per second
  """
  def __init__(self, frames: th.Tensor, fps: float):
        self.frames = frames
        self.fps = fps

```

**Methods**:

- `__init__(frames, fps)`:
  - **Function**: Initialize video data container
  - **Parameters**:
    - `frames`: frames to create the video from
    - `fps`: frames per second

#### 70. `Figure` Class - Figure data container

**Function**: Figure data class storing a matplotlib figure and whether to close the figure after logging it.

**Class Definition**:
```python
class Figure:
    """
    Figure data class storing a matplotlib figure and whether to close the figure after logging it

    :param figure: figure to log
    :param close: if true, close the figure after logging it
    """

    def __init__(self, figure: matplotlib.figure.Figure, close: bool):
        self.figure = figure
        self.close = close

```

**Methods**:

- `__init__(figure, close)`:
  - **Function**: Initialize figure data container
  - **Parameters**:
    - `figure`: figure to log
    - `close`: if true, close the figure after logging it

#### 71. `Image` Class - Image data container

**Function**: Image data class storing an image and data format.

**Class Definition**:
```python
class Image:
    """
    Image data class storing an image and data format

    :param image: image to log
    :param dataformats: Image data format specification of the form NCHW, NHWC, CHW, HWC, HW, WH, etc.
        More info in add_image method doc at https://pytorch.org/docs/stable/tensorboard.html
        Gym envs normally use 'HWC' (channel last)
    """

    def __init__(self, image: Union[th.Tensor, np.ndarray, str], dataformats: str):
        self.image = image
        self.dataformats = dataformats


```

**Methods**:

- `__init__(image, dataformats)`:
  - **Function**: Initialize image data container
  - **Parameters**:
    - `image`: image to log
    - `dataformats`: Image data format specification (NCHW, NHWC, CHW, HWC, HW, WH, etc.)

#### 72. `HParam` Class - Hyperparameter data container

**Function**: Hyperparameter data class storing hyperparameters and metrics in dictionaries.

**Class Definition**:
```python
class HParam:
    """
    Hyperparameter data class storing hyperparameters and metrics in dictionaries

    :param hparam_dict: key-value pairs of hyperparameters to log
    :param metric_dict: key-value pairs of metrics to log
        A non-empty metrics dict is required to display hyperparameters in the corresponding Tensorboard section.
    """

    def __init__(self, hparam_dict: Mapping[str, Union[bool, str, float, None]], metric_dict: Mapping[str, float]):
        self.hparam_dict = hparam_dict
        if not metric_dict:
            raise Exception("`metric_dict` must not be empty to display hyperparameters to the HPARAMS tensorboard tab.")
        self.metric_dict = metric_dict

```

**Methods**:

- `__init__(hparam_dict, metric_dict)`:
  - **Function**: Initialize hyperparameter data container
  - **Parameters**:
    - `hparam_dict`: key-value pairs of hyperparameters to log
    - `metric_dict`: key-value pairs of metrics to log

#### 73. `FormatUnsupportedError` Class - Custom error for unsupported formats

**Function**: Custom error to display informative message when a value is not supported by some formats.

**Class Definition**:
```python
class FormatUnsupportedError(NotImplementedError):
    """
    Custom error to display informative message when
    a value is not supported by some formats.

    :param unsupported_formats: A sequence of unsupported formats,
        for instance ``["stdout"]``.
    :param value_description: Description of the value that cannot be logged by this format.
    """

    def __init__(self, unsupported_formats: Sequence[str], value_description: str):
        if len(unsupported_formats) > 1:
            format_str = f"formats {', '.join(unsupported_formats)} are"
        else:
            format_str = f"format {unsupported_formats[0]} is"
        super().__init__(
            f"The {format_str} not supported for the {value_description} value logged.\n"
            f"You can exclude formats via the `exclude` parameter of the logger's `record` function."
        )
```

**Methods**:

- `__init__(unsupported_formats, value_description)`:
  - **Function**: Initialize format unsupported error
  - **Parameters**:
    - `unsupported_formats`: sequence of unsupported formats
    - `value_description`: description of the unsupported value

#### 74. `KVWriter` Class - Abstract key-value writer

**Function**: Abstract base class for key-value writers.

**Class Definition**:
```python
class KVWriter(ABC):
  """
  Key Value writer
  """
  def write(self, key_values: dict[str, Any], key_excluded: dict[str, tuple[str, ...]], step: int = 0) -> None:
      ...
  def close(self) -> None:
      ...
```

**Methods**:

- `write(key_values, key_excluded, step=0)`:
  - **Function**: Write a dictionary to file (abstract)
  - **Parameters**:
    - `key_values`: key-value pairs to write
    - `key_excluded`: keys excluded per format
    - `step`: step number for logging

- `close()`:
  - **Function**: Close owned resources (abstract)

#### 75. `SeqWriter` Class - Abstract sequence writer

**Function**: Abstract base class for sequence writers.

**Class Definition**:
```python
class SeqWriter(ABC):
  """
    sequence writer
    """
  def write_sequence(self, sequence: list[str]) -> None:
    """
    write_sequence an array to file

    :param sequence:
    """
    raise NotImplementedError

```

**Methods**:

- `write_sequence(sequence)`:
  - **Function**: Write an array to file (abstract)
  - **Parameters**:
    - `sequence`: sequence of strings to write

#### 76. `HumanOutputFormat` Class - Human-readable output format

**Function**: A human-readable output format producing ASCII tables of key-value pairs.

**Class Definition**:
```python
class HumanOutputFormat(KVWriter, SeqWriter):
    def __init__(self, filename_or_file: Union[str, TextIO], max_length: int = 36):
        ...
    def write(self, key_values: dict[str, Any], key_excluded: dict[str, tuple[str, ...]], step: int = 0) -> None:
        ...
    def _truncate(self, string: str) -> str:
        ...
    def write_sequence(self, sequence: list[str]) -> None:
        ...
    def close(self) -> None:
        ...
```

**Methods**:

- `__init__(filename_or_file, max_length=36)`:
  - **Function**: Initialize human output format
  - **Parameters**:
    - `filename_or_file`: file to write to
    - `max_length`: maximum length for keys and values

- `write(key_values, key_excluded, step=0)`:
  - **Function**: Write key-values as ASCII table
  - **Parameters**:
    - `key_values`: key-value pairs to write
    - `key_excluded`: excluded keys
    - `step`: step number

- `_truncate(string)`:
  - **Function**: Truncate string to max length
  - **Parameters**:
    - `string`: string to truncate
  - **Return Value**: truncated string

- `write_sequence(sequence)`:
  - **Function**: Write sequence of strings
  - **Parameters**:
    - `sequence`: sequence to write

#### 77. `filter_excluded_keys` Function - Filter excluded keys

**Function**: Filters the keys specified by key_exclude for the specified format.

**Function Signature**:
```python
def filter_excluded_keys(key_values: dict[str, Any], key_excluded: dict[str, tuple[str, ...]], _format: str) -> dict[str, Any]
    def is_excluded(key: str) -> bool:
      ...
```

**Parameter Description**:
- `key_values`: log dictionary to be filtered
- `key_excluded`: keys to be excluded per format
- `_format`: format for filtering

**Return Value**: filtered dictionary

#### 78. `JSONOutputFormat` Class - JSON output format

**Function**: Log to a file in JSON format.

**Class Definition**:
```python
class JSONOutputFormat(KVWriter):
  """
  Log to a file, in the JSON format

  :param filename: the file to write the log to
  """
  def __init__(self, filename: str):
      ...
  def write(self, key_values: dict[str, Any], key_excluded: dict[str, tuple[str, ...]], step: int = 0) -> None:
      ...
  def close(self) -> None:
      ...
```

**Methods**:

- `__init__(filename)`:
  - **Function**: Initialize JSON output format
  - **Parameters**:
    - `filename`: JSON file to write to

- `write(key_values, key_excluded, step=0)`:
  - **Function**: Write key-values as JSON
  - **Parameters**:
    - `key_values`: key-value pairs to write
    - `key_excluded`: excluded keys
    - `step`: step number

#### 79. `CSVOutputFormat` Class - CSV output format

**Function**: Log to a file in CSV format.

**Class Definition**:
```python
class CSVOutputFormat(KVWriter):
  """
  Log to a file, in a CSV format

  :param filename: the file to write the log to
  """
  def __init__(self, filename: str):
      ...
  def write(self, key_values: dict[str, Any], key_excluded: dict[str, tuple[str, ...]], step: int = 0) -> None:
      ...
  def close(self) -> None:
      ...
```

**Methods**:

- `__init__(filename)`:
  - **Function**: Initialize CSV output format
  - **Parameters**:
    - `filename`: CSV file to write to

- `write(key_values, key_excluded, step=0)`:
  - **Function**: Write key-values as CSV
  - **Parameters**:
    - `key_values`: key-value pairs to write
    - `key_excluded`: excluded keys
    - `step`: step number

#### 80. `TensorBoardOutputFormat` Class - TensorBoard output format

**Function**: Dumps key/value pairs into TensorBoard's numeric format.

**Class Definition**:
```python
class TensorBoardOutputFormat(KVWriter):
  """
  Dumps key/value pairs into TensorBoard's numeric format.

  :param folder: the folder to write the log to
  """

  def __init__(self, folder: str):
      ...
  def write(self, key_values: dict[str, Any], key_excluded: dict[str, tuple[str, ...]], step: int = 0) -> None:
      ...
  def close(self) -> None:
      ...
```

**Methods**:

- `__init__(folder)`:
  - **Function**: Initialize TensorBoard output format
  - **Parameters**:
    - `folder`: TensorBoard log directory

- `write(key_values, key_excluded, step=0)`:
  - **Function**: Write key-values to TensorBoard
  - **Parameters**:
    - `key_values`: key-value pairs to write
    - `key_excluded`: excluded keys
    - `step`: step number

#### 81. `make_output_format` Function - Create output format

**Function**: Return a logger for the requested format.

**Function Signature**:
```python
def make_output_format(_format: str, log_dir: str, log_suffix: str = "") -> KVWriter:
  """
  return a logger for the requested format

  :param _format: the requested format to log to ('stdout', 'log', 'json' or 'csv' or 'tensorboard')
  :param log_dir: the logging directory
  :param log_suffix: the suffix for the log file
  :return: the logger
  """
```

**Parameter Description**:
- `_format`: requested format ('stdout', 'log', 'json', 'csv', or 'tensorboard')
- `log_dir`: logging directory
- `log_suffix`: suffix for log file

**Return Value**: logger instance

#### 82. `Logger` Class - Main logger class

**Function**: The main logger class for recording and outputting training data.

**Class Definition**:
```python
class Logger:
    """
    The logger class.

    :param folder: the logging location
    :param output_formats: the list of output formats
    """
    def __init__(self, folder: Optional[str], output_formats: list[KVWriter]):
        ...
    @staticmethod
    def to_tuple(string_or_tuple: Optional[Union[str, tuple[str, ...]]]) -> tuple[str, ...]:
        ...
    def record(self, key: str, value: Any, exclude: Optional[Union[str, tuple[str, ...]]] = None) -> None:
        ...
    def record_mean(self, key: str, value: Optional[float], exclude: Optional[Union[str, tuple[str, ...]]] = None) -> None:
        ...
    def dump(self, step: int = 0) -> None:
        ...
    def log(self, *args, level: int = INFO) -> None:
        ...
    def debug(self, *args) -> None:
        ...
    def info(self, *args) -> None:
        ...
    def warn(self, *args) -> None:
        ...
    def error(self, *args) -> None:
        ...
    def set_level(self, level: int) -> None:
        ...
    def get_dir(self) -> Optional[str]:
        ...
    def close(self) -> None:
        ...
    def _do_log(self, args: tuple[Any, ...]) -> None:
        ...
```

**Methods**:

- `__init__(folder, output_formats)`:
  - **Function**: Initialize logger
  - **Parameters**:
    - `folder`: logging location
    - `output_formats`: list of output formats

- `to_tuple(string_or_tuple)`:
  - **Function**: Convert str to tuple of str
  - **Parameters**:
    - `string_or_tuple`: string or tuple to convert
  - **Return Value**: tuple of strings

- `record(key, value, exclude=None)`:
  - **Function**: Log a diagnostic value (last value used if called multiple times)
  - **Parameters**:
    - `key`: key to log
    - `value`: value to log
    - `exclude`: outputs to exclude

- `record_mean(key, value, exclude=None)`:
  - **Function**: Log a diagnostic value (values averaged if called multiple times)
  - **Parameters**:
    - `key`: key to log
    - `value`: value to log
    - `exclude`: outputs to exclude

- `dump(step=0)`:
  - **Function**: Write all diagnostics from current iteration
  - **Parameters**:
    - `step`: step number

- `log(*args, level=INFO)`:
  - **Function**: Write sequence of args to console and output files
  - **Parameters**:
    - `args`: arguments to log
    - `level`: logging level

- `debug(*args)`:
  - **Function**: Log with DEBUG level
  - **Parameters**:
    - `args`: arguments to log

- `info(*args)`:
  - **Function**: Log with INFO level
  - **Parameters**:
    - `args`: arguments to log

- `warn(*args)`:
  - **Function**: Log with WARN level
  - **Parameters**:
    - `args`: arguments to log

- `error(*args)`:
  - **Function**: Log with ERROR level
  - **Parameters**:
    - `args`: arguments to log

- `set_level(level)`:
  - **Function**: Set logging threshold
  - **Parameters**:
    - `level`: logging level

- `get_dir()`:
  - **Function**: Get logging directory
  - **Return Value**: logging directory

#### 83. `configure` Function - Configure logger

**Function**: Configure the current logger.

**Function Signature**:
```python
def configure(folder: Optional[str] = None, format_strings: Optional[list[str]] = None) -> Logger:
  """
  Configure the current logger.

  :param folder: the save location
      (if None, $SB3_LOGDIR, if still None, tempdir/SB3-[date & time])
  :param format_strings: the output logging format
      (if None, $SB3_LOG_FORMAT, if still None, ['stdout', 'log', 'csv'])
  :return: The logger object.
  """
```

**Parameter Description**:
- `folder`: save location
- `format_strings`: output logging formats

**Return Value**: configured Logger instance

#### 84. `read_json` Function - Read JSON file

**Function**: Read a JSON file using pandas.

**Function Signature**:
```python
def read_json(filename: str) -> pandas.DataFrame:
  """
  read a json file using pandas

  :param filename: the file path to read
  :return: the data in the json
  """
```

**Parameter Description**:
- `filename`: JSON file path to read

**Return Value**: pandas DataFrame with JSON data

#### 85. `read_csv` Function - Read CSV file

**Function**: Read a CSV file using pandas.

**Function Signature**:
```python
def read_csv(filename: str) -> pandas.DataFrame:
  """
  read a csv file using pandas

  :param filename: the file path to read
  :return: the data in the csv
  """
```

**Parameter Description**:
- `filename`: CSV file path to read

**Return Value**: pandas DataFrame with CSV data

#### 86. `Monitor` Class - Monitor wrapper for Gym environments

**Function**: A monitor wrapper for Gym environments, used to track episode reward, length, time and other data.

**Class Definition**:
```python
class Monitor(gym.Wrapper[ObsType, ActType, ObsType, ActType]):
    def __init__(
        self,
        env: gym.Env,
        filename: Optional[str] = None,
        allow_early_resets: bool = True,
        reset_keywords: tuple[str, ...] = (),
        info_keywords: tuple[str, ...] = (),
        override_existing: bool = True,
    ):
        ...
    def reset(self, **kwargs) -> tuple[ObsType, dict[str, Any]]:
        ...
    def step(self, action: ActType) -> tuple[ObsType, SupportsFloat, bool, bool, dict[str, Any]]:
        ...
    def close(self) -> None:
        ...
    def get_total_steps(self) -> int:
        ...
    def get_episode_rewards(self) -> list[float]:
        ...
    def get_episode_lengths(self) -> list[int]:
        ...
    def get_episode_times(self) -> list[float]:
        ...
```

**Methods**:

- `__init__(env, filename=None, allow_early_resets=True, reset_keywords=(), info_keywords=(), override_existing=True)`:
  - **Function**: Initialize monitor wrapper
  - **Parameters**:
    - `env`: The environment to wrap
    - `filename`: location to save log file, None for no log
    - `allow_early_resets`: allow reset before environment is done
    - `reset_keywords`: extra keywords for reset call
    - `info_keywords`: extra information to log from step() info
    - `override_existing`: append to or override existing files

- `reset(**kwargs)`:
  - **Function**: Reset environment and track reset information
  - **Parameters**:
    - `kwargs`: Extra keywords saved for next episode
  - **Return Value**: First observation and info dictionary

- `step(action)`:
  - **Function**: Step environment and track episode data
  - **Parameters**:
    - `action`: Action to take
  - **Return Value**: Observation, reward, terminated, truncated, info

- `close()`:
  - **Function**: Close environment and results writer

- `get_total_steps()`:
  - **Function**: Get total number of timesteps
  - **Return Value**: Total steps count

- `get_episode_rewards()`:
  - **Function**: Get rewards of all episodes
  - **Return Value**: List of episode rewards

- `get_episode_lengths()`:
  - **Function**: Get timesteps of all episodes
  - **Return Value**: List of episode lengths

- `get_episode_times()`:
  - **Function**: Get runtime of all episodes
  - **Return Value**: List of episode times

#### 87. `LoadMonitorResultsError` Class - Monitor load error

**Function**: Raised when loading the monitor log fails.

**Class Definition**:
```python
class LoadMonitorResultsError(Exception):
  """
  Raised when loading the monitor log fails.
  """

  pass

```

#### 88. `ResultsWriter` Class - Result writer for Monitor data

**Function**: A result writer that saves the data from the Monitor class to CSV files.

**Class Definition**:
```python
class ResultsWriter:
    def __init__(
        self,
        filename: str = "",
        header: Optional[dict[str, Union[float, str]]] = None,
        extra_keys: tuple[str, ...] = (),
        override_existing: bool = True,
    ):
        ...
    def write_row(self, epinfo: dict[str, float]) -> None:
        ...
    def close(self) -> None:
        ...
```

**Methods**:

- `__init__(filename="", header=None, extra_keys=(), override_existing=True)`:
  - **Function**: Initialize results writer
  - **Parameters**:
    - `filename`: location to save log file
    - `header`: header dictionary for CSV
    - `extra_keys`: extra information keys to log
    - `override_existing`: append to or override existing files

- `write_row(epinfo)`:
  - **Function**: Write row of monitor data to CSV
  - **Parameters**:
    - `epinfo`: episodic return, length, and time information

- `close()`:
  - **Function**: Close the file handler

#### 89. `get_monitor_files` Function - Get monitor files in directory

**Function**: Get all the monitor files in the given path.

**Function Signature**:
```python
def get_monitor_files(path: str) -> list[str]:
  """
  get all the monitor files in the given path

  :param path: the logging folder
  :return: the log files
  """
```

**Parameter Description**:
- `path`: the logging folder

**Return Value**: list of monitor log files

#### 90. `load_results` Function - Load monitor results from directory

**Function**: Load all Monitor logs from a given directory path matching the monitor file pattern.

**Function Signature**:
```python
def load_results(path: str) -> pandas.DataFrame:
  """
  Load all Monitor logs from a given directory path matching ``*monitor.csv``

  :param path: the directory path containing the log file(s)
  :return: the logged data
  """
```

**Parameter Description**:
- `path`: directory path containing log files

**Return Value**: logged data as pandas DataFrame


++
#### 91. `ActionNoise` Class - Abstract Base for Action Noise

**Function**: Abstract base class for all action noise implementations.

**Class Definition**:
```python
class ActionNoise(ABC):
  """
  The action noise base class
  """
  def __init__(self) -> None:
      ...

  def reset(self) -> None:
      ...

  @abstractmethod
  def __call__(self) -> np.ndarray:
      ...

```

**Core Methods**:
- **`__call__()`**: Abstract method to generate noise samples
- **`reset()`**: Reset noise state (optional implementation)

#### 92. `NormalActionNoise` Class - Gaussian Action Noise

**Function**: Gaussian (normal) distribution noise for exploration.

**Class Definition**:
```python
class NormalActionNoise(ActionNoise):
  """
  A Gaussian action noise.

  :param mean: Mean value of the noise
  :param sigma: Scale of the noise (std here)
  :param dtype: Type of the output noise
  """
  def __init__(self, mean: np.ndarray, sigma: np.ndarray, dtype: DTypeLike = np.float32) -> None:
      ...

  def __call__(self) -> np.ndarray:
      ...
  def __repr__(self) -> str: ...
```

**Key Parameters**:
- `mean`: Mean value of the Gaussian distribution
- `sigma`: Standard deviation (scale) of the distribution
- `dtype`: Data type of the output noise

**Details**:
- Generates independent Gaussian noise each call
- No internal state or temporal correlation
- Suitable for simple exploration strategies

#### 93. `OrnsteinUhlenbeckActionNoise` Class - Correlated Action Noise

**Function**: Ornstein-Uhlenbeck process noise for temporally correlated exploration.

**Class Definition**:
```python
class OrnsteinUhlenbeckActionNoise(ActionNoise):
  """
  An Ornstein Uhlenbeck action noise, this is designed to approximate Brownian motion with friction.

  Based on http://math.stackexchange.com/questions/1287634/implementing-ornstein-uhlenbeck-in-matlab

  :param mean: Mean of the noise
  :param sigma: Scale of the noise
  :param theta: Rate of mean reversion
  :param dt: Timestep for the noise
  :param initial_noise: Initial value for the noise output, (if None: 0)
  :param dtype: Type of the output noise
  """
  def __init__(
      self,
      mean: np.ndarray,
      sigma: np.ndarray,
      theta: float = 0.15,
      dt: float = 1e-2,
      initial_noise: Optional[np.ndarray] = None,
      dtype: DTypeLike = np.float32,
  ) -> None:
      ...

  def __call__(self) -> np.ndarray:
      ...

  def reset(self) -> None:
      ...
```

**Key Parameters**:
- `mean`: Long-term mean of the process
- `sigma`: Noise scale (volatility)
- `theta`: Rate of mean reversion
- `dt`: Time step for the discrete process
- `initial_noise`: Starting value for the process

**Mathematical Formulation**:
```python
noise_t = noise_{t-1} + theta * (mean - noise_{t-1}) * dt + sigma * sqrt(dt) * N(0,1)
```

**Details**:
- Models Brownian motion with friction
- Produces smooth, correlated noise trajectories
- Commonly used in continuous control tasks (e.g., DDPG)
- Maintains internal state between calls

#### 94. `VectorizedActionNoise` Class - Parallel Environment Noise

**Function**: Manages independent noise processes for parallel environments.

**Class Definition**:
```python
class VectorizedActionNoise(ActionNoise):
  """
  A Vectorized action noise for parallel environments.

  :param base_noise: Noise generator to use
  :param n_envs: Number of parallel environments
  """
  def __init__(self, base_noise: ActionNoise, n_envs: int) -> None:
      ...

  def reset(self, indices: Optional[Iterable[int]] = None) -> None:
      ...
  def __repr__(self) -> str: ...
  
  def __call__(self) -> np.ndarray:
      ...
  @property
  def base_noise(self) -> ActionNoise: ...

  @base_noise.setter
  def base_noise(self, base_noise: ActionNoise) -> None: ...

  @property
  def noises(self) -> list[ActionNoise]: ...

  @noises.setter
  def noises(self, noises: list[ActionNoise]) -> None: ...
```

**Key Parameters**:
- `base_noise`: Template noise generator to clone for each environment
- `n_envs`: Number of parallel environments

**Core Methods**:
- **`reset(indices)`**: Reset specific environment noise processes
- **`__call__()`**: Generate stacked noise for all environments

**Details**:
- Creates independent noise instances for each parallel environment
- Allows selective reset of specific environment noises
- Maintains separate states for each environment
- Essential for vectorized environment training

**Usage Patterns**:
- **NormalActionNoise**: Simple exploration in SAC, TD3
- **OrnsteinUhlenbeckActionNoise**: Exploration in DDPG for continuous control
- **VectorizedActionNoise**: All algorithms using parallel environments

**Integration**:
- Used by off-policy algorithms during training
- Injected into actions for exploration
- Configurable through algorithm constructors
- Automatically reset at episode boundaries



#### 95. `OnPolicyAlgorithm` Class - Base class for on-policy algorithms

**Function**: The base for On-Policy algorithms (ex: A2C/PPO) that learn from complete episodes.

**Class Definition**:
```python
class OnPolicyAlgorithm(BaseAlgorithm):
  """
  The base for On-Policy algorithms (ex: A2C/PPO).

  :param policy: The policy model to use (MlpPolicy, CnnPolicy, ...)
  :param env: The environment to learn from (if registered in Gym, can be str)
  :param learning_rate: The learning rate, it can be a function
      of the current progress remaining (from 1 to 0)
  :param n_steps: The number of steps to run for each environment per update
      (i.e. batch size is n_steps * n_env where n_env is number of environment copies running in parallel)
  :param gamma: Discount factor
  :param gae_lambda: Factor for trade-off of bias vs variance for Generalized Advantage Estimator.
      Equivalent to classic advantage when set to 1.
  :param ent_coef: Entropy coefficient for the loss calculation
  :param vf_coef: Value function coefficient for the loss calculation
  :param max_grad_norm: The maximum value for the gradient clipping
  :param use_sde: Whether to use generalized State Dependent Exploration (gSDE)
      instead of action noise exploration (default: False)
  :param sde_sample_freq: Sample a new noise matrix every n steps when using gSDE
      Default: -1 (only sample at the beginning of the rollout)
  :param rollout_buffer_class: Rollout buffer class to use. If ``None``, it will be automatically selected.
  :param rollout_buffer_kwargs: Keyword arguments to pass to the rollout buffer on creation.
  :param stats_window_size: Window size for the rollout logging, specifying the number of episodes to average
      the reported success rate, mean episode length, and mean reward over
  :param tensorboard_log: the log location for tensorboard (if None, no logging)
  :param monitor_wrapper: When creating an environment, whether to wrap it
      or not in a Monitor wrapper.
  :param policy_kwargs: additional arguments to be passed to the policy on creation
  :param verbose: Verbosity level: 0 for no output, 1 for info messages (such as device or wrappers used), 2 for
      debug messages
  :param seed: Seed for the pseudo random generators
  :param device: Device (cpu, cuda, ...) on which the code should be run.
      Setting it to auto, the code will be run on the GPU if possible.
  :param _init_setup_model: Whether or not to build the network at the creation of the instance
  :param supported_action_spaces: The action spaces supported by the algorithm.
  """
  rollout_buffer: RolloutBuffer
  policy: ActorCriticPolicy
  def __init__(
      self,
      policy: Union[str, type[ActorCriticPolicy]],
      env: Union[GymEnv, str],
      learning_rate: Union[float, Schedule],
      n_steps: int,
      gamma: float,
      gae_lambda: float,
      ent_coef: float,
      vf_coef: float,
      max_grad_norm: float,
      use_sde: bool,
      sde_sample_freq: int,
      rollout_buffer_class: Optional[type[RolloutBuffer]] = None,
      rollout_buffer_kwargs: Optional[dict[str, Any]] = None,
      stats_window_size: int = 100,
      tensorboard_log: Optional[str] = None,
      monitor_wrapper: bool = True,
      policy_kwargs: Optional[dict[str, Any]] = None,
      verbose: int = 0,
      seed: Optional[int] = None,
      device: Union[th.device, str] = "auto",
      _init_setup_model: bool = True,
      supported_action_spaces: Optional[tuple[type[spaces.Space], ...]] = None,
  ):
      ...
  def _setup_model(self) -> None:
      ...
  def _maybe_recommend_cpu(self, mlp_class_name: str = "ActorCriticPolicy") -> None:
      ...
  def collect_rollouts(
      self,
      env: VecEnv,
      callback: BaseCallback,
      rollout_buffer: RolloutBuffer,
      n_rollout_steps: int,
  ) -> bool:
      ...
  def train(self) -> None:
      ...
  def dump_logs(self, iteration: int = 0) -> None:
      ...
  def learn(
      self: SelfOnPolicyAlgorithm,
      total_timesteps: int,
      callback: MaybeCallback = None,
      log_interval: int = 1,
      tb_log_name: str = "OnPolicyAlgorithm",
      reset_num_timesteps: bool = True,
      progress_bar: bool = False,
  ) -> SelfOnPolicyAlgorithm:
      ...
  def _get_torch_save_params(self) -> tuple[list[str], list[str]]:
      ...
```

**Methods**:

- `__init__(policy, env, learning_rate, n_steps, gamma, gae_lambda, ent_coef, vf_coef, max_grad_norm, use_sde, sde_sample_freq, rollout_buffer_class=None, rollout_buffer_kwargs=None, stats_window_size=100, tensorboard_log=None, monitor_wrapper=True, policy_kwargs=None, verbose=0, seed=None, device="auto", _init_setup_model=True, supported_action_spaces=None)`:
  - **Function**: Initialize on-policy algorithm
  - **Parameters**:
    - `n_steps`: Number of steps per environment per update
    - `gamma`: Discount factor
    - `gae_lambda`: GAE lambda parameter for advantage estimation
    - `ent_coef`: Entropy coefficient for loss calculation
    - `vf_coef`: Value function coefficient for loss calculation
    - `max_grad_norm`: Maximum value for gradient clipping
    - `rollout_buffer_class`: Rollout buffer class to use
    - `rollout_buffer_kwargs`: Keyword arguments for rollout buffer

- `_setup_model()`:
  - **Function**: Setup model components including rollout buffer and policy
  - **Details**: Initializes learning rate schedule, rollout buffer, and policy network

- `_maybe_recommend_cpu(mlp_class_name="ActorCriticPolicy")`:
  - **Function**: Recommend using CPU when appropriate for MLP policies
  - **Parameters**:
    - `mlp_class_name`: Name of the MLP policy class

- `collect_rollouts(env, callback, rollout_buffer, n_rollout_steps)`:
  - **Function**: Collect experiences using current policy and fill rollout buffer
  - **Parameters**:
    - `env`: The training environment
    - `callback`: Callback called at each step
    - `rollout_buffer`: Buffer to fill with rollouts
    - `n_rollout_steps`: Number of experiences to collect per environment
  - **Return Value**: True if collected enough steps, False if callback terminated early
  - **Details**: 
    - Switches to eval mode for policy
    - Handles state-dependent exploration noise
    - Processes actions and observations
    - Computes returns and advantages

- `train()`:
  - **Function**: Consume rollout data and update policy parameters (abstract)
  - **Details**: Implemented by individual algorithms like A2C/PPO

- `dump_logs(iteration=0)`:
  - **Function**: Write training logs including rewards, lengths, and performance metrics
  - **Parameters**:
    - `iteration`: Current logging iteration
  - **Details**: Records episode rewards, lengths, FPS, success rates, etc.

- `learn(total_timesteps, callback=None, log_interval=1, tb_log_name="OnPolicyAlgorithm", reset_num_timesteps=True, progress_bar=False)`:
  - **Function**: Train the model for specified number of timesteps
  - **Parameters**:
    - `total_timesteps`: Total timesteps to train for
    - `callback`: Callback for training events
    - `log_interval`: Logging frequency in iterations
    - `tb_log_name`: TensorBoard log name
    - `reset_num_timesteps`: Reset timestep counter
    - `progress_bar`: Show progress bar
  - **Return Value**: Self for method chaining
  - **Details**: Main training loop that alternates between collecting rollouts and policy updates

- `_get_torch_save_params()`:
  - **Function**: Get parameters to save with PyTorch
  - **Return Value**: Tuple of state dict names and other torch variables


#### 96. `OffPolicyAlgorithm` Class - Base class for off-policy algorithms

**Function**: The base for Off-Policy algorithms (ex: SAC/TD3) that learn from a replay buffer of past experiences.

**Class Definition**:
```python
class OffPolicyAlgorithm(BaseAlgorithm):
  """
  The base for Off-Policy algorithms (ex: SAC/TD3)

  :param policy: The policy model to use (MlpPolicy, CnnPolicy, ...)
  :param env: The environment to learn from
              (if registered in Gym, can be str. Can be None for loading trained models)
  :param learning_rate: learning rate for the optimizer,
      it can be a function of the current progress remaining (from 1 to 0)
  :param buffer_size: size of the replay buffer
  :param learning_starts: how many steps of the model to collect transitions for before learning starts
  :param batch_size: Minibatch size for each gradient update
  :param tau: the soft update coefficient ("Polyak update", between 0 and 1)
  :param gamma: the discount factor
  :param train_freq: Update the model every ``train_freq`` steps. Alternatively pass a tuple of frequency and unit
      like ``(5, "step")`` or ``(2, "episode")``.
  :param gradient_steps: How many gradient steps to do after each rollout (see ``train_freq``)
      Set to ``-1`` means to do as many gradient steps as steps done in the environment
      during the rollout.
  :param action_noise: the action noise type (None by default), this can help
      for hard exploration problem. Cf common.noise for the different action noise type.
  :param replay_buffer_class: Replay buffer class to use (for instance ``HerReplayBuffer``).
      If ``None``, it will be automatically selected.
  :param replay_buffer_kwargs: Keyword arguments to pass to the replay buffer on creation.
  :param optimize_memory_usage: Enable a memory efficient variant of the replay buffer
      at a cost of more complexity.
      See https://github.com/DLR-RM/stable-baselines3/issues/37#issuecomment-637501195
  :param n_steps: When n_step > 1, uses n-step return (with the NStepReplayBuffer) when updating the Q-value network.
  :param policy_kwargs: Additional arguments to be passed to the policy on creation
  :param stats_window_size: Window size for the rollout logging, specifying the number of episodes to average
      the reported success rate, mean episode length, and mean reward over
  :param tensorboard_log: the log location for tensorboard (if None, no logging)
  :param verbose: Verbosity level: 0 for no output, 1 for info messages (such as device or wrappers used), 2 for
      debug messages
  :param device: Device on which the code should run.
      By default, it will try to use a Cuda compatible device and fallback to cpu
      if it is not possible.
  :param support_multi_env: Whether the algorithm supports training
      with multiple environments (as in A2C)
  :param monitor_wrapper: When creating an environment, whether to wrap it
      or not in a Monitor wrapper.
  :param seed: Seed for the pseudo random generators
  :param use_sde: Whether to use State Dependent Exploration (SDE)
      instead of action noise exploration (default: False)
  :param sde_sample_freq: Sample a new noise matrix every n steps when using gSDE
      Default: -1 (only sample at the beginning of the rollout)
  :param use_sde_at_warmup: Whether to use gSDE instead of uniform sampling
      during the warm up phase (before learning starts)
  :param sde_support: Whether the model support gSDE or not
  :param supported_action_spaces: The action spaces supported by the algorithm.
  """
  actor: th.nn.Module

  def __init__(
      self,
      policy: Union[str, type[BasePolicy]],
      env: Union[GymEnv, str],
      learning_rate: Union[float, Schedule],
      buffer_size: int = 1_000_000,
      learning_starts: int = 100,
      batch_size: int = 256,
      tau: float = 0.005,
      gamma: float = 0.99,
      train_freq: Union[int, tuple[int, str]] = (1, "step"),
      gradient_steps: int = 1,
      action_noise: Optional[ActionNoise] = None,
      replay_buffer_class: Optional[type[ReplayBuffer]] = None,
      replay_buffer_kwargs: Optional[dict[str, Any]] = None,
      optimize_memory_usage: bool = False,
      n_steps: int = 1,
      policy_kwargs: Optional[dict[str, Any]] = None,
      stats_window_size: int = 100,
      tensorboard_log: Optional[str] = None,
      verbose: int = 0,
      device: Union[th.device, str] = "auto",
      support_multi_env: bool = False,
      monitor_wrapper: bool = True,
      seed: Optional[int] = None,
      use_sde: bool = False,
      sde_sample_freq: int = -1,
      use_sde_at_warmup: bool = False,
      sde_support: bool = True,
      supported_action_spaces: Optional[tuple[type[spaces.Space], ...]] = None,
  ):
      ...
  def _convert_train_freq(self) -> None:
      ...
  def _setup_model(self) -> None:
      ...
  def save_replay_buffer(self, path: Union[str, pathlib.Path, io.BufferedIOBase]) -> None:
      ...
  def load_replay_buffer(
      self,
      path: Union[str, pathlib.Path, io.BufferedIOBase],
      truncate_last_traj: bool = True,
  ) -> None:
      ...
  def _setup_learn(
      self,
      total_timesteps: int,
      callback: MaybeCallback = None,
      reset_num_timesteps: bool = True,
      tb_log_name: str = "run",
      progress_bar: bool = False,
  ) -> tuple[int, BaseCallback]:
      ...
  def learn(
      self: SelfOffPolicyAlgorithm,
      total_timesteps: int,
      callback: MaybeCallback = None,
      log_interval: int = 4,
      tb_log_name: str = "run",
      reset_num_timesteps: bool = True,
      progress_bar: bool = False,
  ) -> SelfOffPolicyAlgorithm:
      ...
  def train(self, gradient_steps: int, batch_size: int) -> None:
      ...
  def _sample_action(
      self,
      learning_starts: int,
      action_noise: Optional[ActionNoise] = None,
      n_envs: int = 1,
  ) -> tuple[np.ndarray, np.ndarray]:
      ...
  def dump_logs(self) -> None:
      ...
  def _on_step(self) -> None:
      ...
  def _store_transition(
      self,
      replay_buffer: ReplayBuffer,
      buffer_action: np.ndarray,
      new_obs: Union[np.ndarray, dict[str, np.ndarray]],
      reward: np.ndarray,
      dones: np.ndarray,
      infos: list[dict[str, Any]],
  ) -> None:
      ...
  def collect_rollouts(
      self,
      env: VecEnv,
      callback: BaseCallback,
      train_freq: TrainFreq,
      replay_buffer: ReplayBuffer,
      action_noise: Optional[ActionNoise] = None,
      learning_starts: int = 0,
      log_interval: Optional[int] = None,
  ) -> RolloutReturn:
      ...
```

**Methods**:

- `__init__(policy, env, learning_rate, buffer_size=1000000, learning_starts=100, batch_size=256, tau=0.005, gamma=0.99, train_freq=(1, "step"), gradient_steps=1, action_noise=None, replay_buffer_class=None, replay_buffer_kwargs=None, optimize_memory_usage=False, n_steps=1, policy_kwargs=None, stats_window_size=100, tensorboard_log=None, verbose=0, device="auto", support_multi_env=False, monitor_wrapper=True, seed=None, use_sde=False, sde_sample_freq=-1, use_sde_at_warmup=False, sde_support=True, supported_action_spaces=None)`:
  - **Function**: Initialize off-policy algorithm
  - **Parameters**:
    - `buffer_size`: Size of the replay buffer
    - `learning_starts`: Steps to collect before learning starts
    - `batch_size`: Minibatch size for gradient updates
    - `tau`: Soft update coefficient (Polyak update)
    - `train_freq`: Model update frequency (steps or episodes)
    - `gradient_steps`: Gradient steps after each rollout
    - `action_noise`: Action noise for exploration
    - `replay_buffer_class`: Replay buffer class to use
    - `optimize_memory_usage`: Enable memory efficient replay buffer
    - `n_steps`: Use n-step returns when > 1
    - `use_sde_at_warmup`: Use gSDE during warmup phase

- `_convert_train_freq()`:
  - **Function**: Convert train_freq parameter to TrainFreq object
  - **Details**: Handles both integer and tuple formats for training frequency

- `_setup_model()`:
  - **Function**: Setup model components including replay buffer and policy
  - **Details**: Initializes learning rate schedule, replay buffer, and policy network

- `save_replay_buffer(path)`:
  - **Function**: Save the replay buffer as a pickle file
  - **Parameters**:
    - `path`: Path to save the replay buffer

- `load_replay_buffer(path, truncate_last_traj=True)`:
  - **Function**: Load a replay buffer from a pickle file
  - **Parameters**:
    - `path`: Path to the pickled replay buffer
    - `truncate_last_traj`: Truncate last trajectory for HerReplayBuffer

- `_setup_learn(total_timesteps, callback=None, reset_num_timesteps=True, tb_log_name="run", progress_bar=False)`:
  - **Function**: Setup learning process with replay buffer handling
  - **Parameters**:
    - `total_timesteps`: Total timesteps to train
    - `callback`: Training callback
    - `reset_num_timesteps`: Reset timestep counter
    - `tb_log_name`: TensorBoard log name
    - `progress_bar`: Show progress bar
  - **Return Value**: Total timesteps and callback

- `learn(total_timesteps, callback=None, log_interval=4, tb_log_name="run", reset_num_timesteps=True, progress_bar=False)`:
  - **Function**: Train the model for specified number of timesteps
  - **Parameters**:
    - `total_timesteps`: Total timesteps to train for
    - `callback`: Callback for training events
    - `log_interval`: Logging frequency
    - `tb_log_name`: TensorBoard log name
    - `reset_num_timesteps`: Reset timestep counter
    - `progress_bar`: Show progress bar
  - **Return Value**: Self for method chaining
  - **Details**: Main training loop that alternates between collecting experiences and policy updates

- `train(gradient_steps, batch_size)`:
  - **Function**: Sample replay buffer and perform updates (abstract)
  - **Parameters**:
    - `gradient_steps`: Number of gradient steps
    - `batch_size`: Batch size for sampling
  - **Details**: Implemented by individual algorithms like SAC/TD3

- `_sample_action(learning_starts, action_noise=None, n_envs=1)`:
  - **Function**: Sample action according to exploration policy
  - **Parameters**:
    - `learning_starts`: Steps before learning starts
    - `action_noise`: Action noise for exploration
    - `n_envs`: Number of environments
  - **Return Value**: Tuple of (action, buffer_action)
  - **Details**: Handles warmup phase, action scaling, and noise addition

- `dump_logs()`:
  - **Function**: Write training logs including performance metrics
  - **Details**: Records episode rewards, lengths, FPS, success rates, etc.

- `_on_step()`:
  - **Function**: Method called after each step for target network updates
  - **Details**: Used by DQN for target network updates

- `_store_transition(replay_buffer, buffer_action, new_obs, reward, dones, infos)`:
  - **Function**: Store transition in replay buffer
  - **Parameters**:
    - `replay_buffer`: Replay buffer to store transition
    - `buffer_action`: Normalized action
    - `new_obs`: Next observation
    - `reward`: Transition reward
    - `dones`: Termination signals
    - `infos`: Additional information
  - **Details**: Handles terminal observations and normalization

- `collect_rollouts(env, callback, train_freq, replay_buffer, action_noise=None, learning_starts=0, log_interval=None)`:
  - **Function**: Collect experiences and store in replay buffer
  - **Parameters**:
    - `env`: Training environment
    - `callback`: Step callback
    - `train_freq`: Experience collection frequency
    - `replay_buffer`: Replay buffer to fill
    - `action_noise`: Action noise for exploration
    - `learning_starts`: Steps before learning
    - `log_interval`: Logging frequency
  - **Return Value**: RolloutReturn with step and episode counts
  - **Details**: Main experience collection loop with action sampling and transition storage



#### 97. `is_image_space` Function - Check if Space is Valid Image Space

**Function**: Check if an observation space has the shape, limits and dtype of a valid image.

**Function Signature**:
```python
def is_image_space(
    observation_space: spaces.Space,
    check_channels: bool = False,
    normalized_image: bool = False,
) -> bool: ...
```

**Parameter Description**:
- `observation_space`: The space to check
- `check_channels`: Whether to check for valid number of channels
- `normalized_image`: Whether image is already normalized (disables dtype/bounds checks)

**Return Value**: `True` if space is a valid image space, `False` otherwise

#### 98. `preprocess_obs` Function - Preprocess Observations for Neural Network

**Function**: Preprocess observations to be fed to a neural network.

**Function Signature**:
```python
def preprocess_obs(
    obs: Union[th.Tensor, dict[str, th.Tensor]],
    observation_space: spaces.Space,
    normalize_images: bool = True,
) -> Union[th.Tensor, dict[str, th.Tensor]]: ...
```

**Parameter Description**:
- `obs`: Observation tensor or dictionary of tensors
- `observation_space`: The observation space definition
- `normalize_images`: Whether to normalize image values by 255

**Return Value**: Preprocessed observation tensor(s)

#### 99. `get_obs_shape` Function - Get Observation Space Shape

**Function**: Get the shape of the observation space.

**Function Signature**:
```python
def get_obs_shape(
    observation_space: spaces.Space,
) -> Union[tuple[int, ...], dict[str, tuple[int, ...]]]: ...
```

**Parameter Description**: `observation_space`: The observation space to get shape for

**Return Value**: Shape tuple or dictionary of shapes for Dict spaces

#### 100. `get_flattened_obs_dim` Function - Get Flattened Observation Dimension

**Function**: Get the dimension of the observation space when flattened.

**Function Signature**:
```python
def get_flattened_obs_dim(observation_space: spaces.Space) -> int: ...
```

**Parameter Description**: `observation_space`: The observation space to get dimension for

**Return Value**: Integer dimension of flattened observation space

#### 101. `get_action_dim` Function - Get Action Space Dimension

**Function**: Get the dimension of the action space.

**Function Signature**:
```python
def get_action_dim(action_space: spaces.Space) -> int: ...
```

**Parameter Description**: `action_space`: The action space to get dimension for

**Return Value**: Integer dimension of action space

#### 102. `check_for_nested_spaces` Function - Check for Nested Spaces

**Function**: Check that observation space does not have nested spaces.

**Function Signature**:
```python
def check_for_nested_spaces(obs_space: spaces.Space) -> None: ...
```

**Parameter Description**: `obs_space`: Observation space to check

**Return Value**: None, raises exception if nested spaces found

#### 103. `X_TIMESTEPS` constant - timesteps
**Description**: X-axis type constant for timesteps
**Value**: "timesteps"

#### 104. `X_EPISODES` constant - episodes
**Description**: X-axis type constant for episodes
**Value**: "episodes"

#### 105. `X_WALLTIME` constant - walltime_hrs
**Description**: X-axis type constant for walltime in hours
**Value**: "walltime_hrs"

#### 106. `POSSIBLE_X_AXES` constant - possible x axes
**Description**: List of possible x-axis types
**Value**: [X_TIMESTEPS, X_EPISODES, X_WALLTIME]

#### 107. `EPISODES_WINDOW` constant - episodes window
**Description**: Window size for rolling operations
**Value**: 100

#### 108. `rolling_window` function - Apply rolling window to array
**Function**: Apply a rolling window to a np.ndarray
**Function Signature**:
```python
def rolling_window(array: np.ndarray, window: int) -> np.ndarray: ...
```
**Parameter Description**:
  - `array`: the input Array
  - `window`: length of the rolling window
**Return Value**: rolling window on the input array

#### 109. `window_func` function - Apply function to rolling window of 2 arrays
**Function**: Apply a function to the rolling window of 2 arrays
**Function Signature**:
```python
def window_func(var_1: np.ndarray, var_2: np.ndarray, window: int, func: Callable) -> tuple[np.ndarray, np.ndarray]: ...
```
**Parameter Description**:
  - `var_1`: variable 1
  - `var_2`: variable 2
  - `window`: length of the rolling window
  - `func`: function to apply on the rolling window on variable 2 (such as np.mean)
**Return Value**: the rolling output with applied function

#### 110. `ts2xy` function - Decompose dataframe to x and y coordinates
**Function**: Decompose a data frame variable to x and ys (y = episodic return)
**Function Signature**:
```python
def ts2xy(data_frame: pd.DataFrame, x_axis: str) -> tuple[np.ndarray, np.ndarray]: ...
```
**Parameter Description**:
  - `data_frame`: the input data
  - `x_axis`: the x-axis for the x and y output (can be X_TIMESTEPS='timesteps', X_EPISODES='episodes' or X_WALLTIME='walltime_hrs')
**Return Value**: the x and y output
**Details**: Raises NotImplementedError for unsupported x_axis values

#### 111. `plot_curves` function - Plot curves from xy coordinates
**Function**: plot the curves
**Function Signature**:
```python
def plot_curves(xy_list: list[tuple[np.ndarray, np.ndarray]], x_axis: str, title: str, figsize: tuple[int, int] = (8, 2)) -> None: ...
```
**Parameter Description**:
  - `xy_list`: the x and y coordinates to plot
  - `x_axis`: the axis for the x and y output (can be X_TIMESTEPS='timesteps', X_EPISODES='episodes' or X_WALLTIME='walltime_hrs')
  - `title`: the title of the plot
  - `figsize`: Size of the figure (width, height)
**Return Value**: None

#### 112. `plot_results` function - Plot results from monitor csv files
**Function**: Plot the results using csv files from ``Monitor`` wrapper.
**Function Signature**:
```python
def plot_results(dirs: list[str], num_timesteps: Optional[int], x_axis: str, task_name: str, figsize: tuple[int, int] = (8, 2)) -> None :
  """
    Plot the results using csv files from ``Monitor`` wrapper.

    :param dirs: the save location of the results to plot
    :param num_timesteps: only plot the points below this value
    :param x_axis: the axis for the x and y output
        (can be X_TIMESTEPS='timesteps', X_EPISODES='episodes' or X_WALLTIME='walltime_hrs')
    :param task_name: the title of the task to plot
    :param figsize: Size of the figure (width, height)
    """
```
**Parameter Description**:
  - `dirs`: the save location of the results to plot
  - `num_timesteps`: only plot the points below this value
  - `x_axis`: the axis for the x and y output (can be X_TIMESTEPS='timesteps', X_EPISODES='episodes' or X_WALLTIME='walltime_hrs')
  - `task_name`: the title of the task to plot
  - `figsize`: Size of the figure (width, height)
**Return Value**: None

#### 113. `RunningMeanStd` Class - Running Statistics Calculator

**Function**: Calculates running mean and standard deviation of a data stream using parallel algorithm.

**Class Definition**:

```python
class RunningMeanStd:
    def __init__(self, epsilon: float = 1e-4, shape: tuple[int, ...] = ()):
        ...
    def copy(self) -> "RunningMeanStd":
        ...
    def combine(self, other: "RunningMeanStd") -> None:
        ...
    def update(self, arr: np.ndarray) -> None:
        ...
    def update_from_moments(self, batch_mean: np.ndarray, batch_var: np.ndarray, batch_count: float) -> None:
        ...
```

**Key Parameters**:
- `epsilon`: Small value to prevent arithmetic issues
- `shape`: Shape of the data stream output

**Core Methods**:

- `update(arr)`:
  - **Function**: Update statistics with a new batch of data.
  - **Parameters**: `arr`: New data array to incorporate
  - **Details**: Computes batch mean/variance and updates running statistics.

- `update_from_moments(batch_mean, batch_var, batch_count)`:
  - **Function**: Update statistics using pre-computed batch moments.
  - **Parameters**:
    - `batch_mean`: Mean of the new batch
    - `batch_var`: Variance of the new batch  
    - `batch_count`: Number of samples in batch
  - **Details**: Implements parallel variance algorithm to combine statistics.

- `combine(other)`:
  - **Function**: Combine statistics from another RunningMeanStd object.
  - **Parameters**: `other`: Another RunningMeanStd instance to merge with

- `copy()`:
  - **Function**: Create a copy of the current object.
  - **Return Value**: New RunningMeanStd instance with same statistics


#### 114. `recursive_getattr` function - Recursive version of getattr
**Function**: Recursive version of getattr
**Function Signature**:
```python
def recursive_getattr(obj: Any, attr: str, *args) -> Any: ...
```
**Parameter Description**:
  - `obj`: Object to get attribute from
  - `attr`: Attribute to retrieve (supports dot notation for nested attributes)
  - `*args`: Additional arguments passed to getattr
**Return Value**: The attribute value

#### 115. `recursive_setattr` function - Recursive version of setattr
**Function**: Recursive version of setattr
**Function Signature**:
```python
def recursive_setattr(obj: Any, attr: str, val: Any) -> None: 
  """
  Recursive version of setattr
  taken from https://stackoverflow.com/questions/31174295

  Ex:
  > MyObject.sub_object = SubObject(name='test')
  > recursive_setattr(MyObject, 'sub_object.name', 'hello')
  :param obj:
  :param attr: Attribute to set
  :param val: New value of the attribute
  """
```
**Parameter Description**:
  - `obj`: Object to set attribute on
  - `attr`: Attribute to set (supports dot notation for nested attributes)
  - `val`: New value of the attribute
**Return Value**: None

#### 116. `is_json_serializable` function - Test if object is JSON serializable
**Function**: Test if an object is serializable into JSON
**Function Signature**:
```python
def is_json_serializable(item: Any) -> bool:
  """
  Test if an object is serializable into JSON

  :param item: The object to be tested for JSON serialization.
  :return: True if object is JSON serializable, false otherwise.
  """
```
**Parameter Description**:
  - `item`: The object to be tested for JSON serialization
**Return Value**: True if object is JSON serializable, false otherwise

#### 117. `data_to_json` function - Convert data to JSON string
**Function**: Turn data (class parameters) into a JSON string for storing
**Function Signature**:
```python
def data_to_json(data: dict[str, Any]) -> str:
  """
  Turn data (class parameters) into a JSON string for storing

  :param data: Dictionary of class parameters to be
      stored. Items that are not JSON serializable will be
      pickled with Cloudpickle and stored as bytearray in
      the JSON file
  :return: JSON string of the data serialized.
  """
```
**Parameter Description**:
  - `data`: Dictionary of class parameters to be stored
**Return Value**: JSON string of the data serialized
**Details**: Non-JSON serializable items are pickled with Cloudpickle and stored as base64 encoded bytearrays

#### 118. `json_to_data` function - Convert JSON string back to data
**Function**: Turn JSON serialization of class-parameters back into dictionary
**Function Signature**:
```python
def json_to_data(json_string: str, custom_objects: Optional[dict[str, Any]] = None) -> dict[str, Any]:
  """
  Turn JSON serialization of class-parameters back into dictionary.

  :param json_string: JSON serialization of the class-parameters
      that should be loaded.
  :param custom_objects: Dictionary of objects to replace
      upon loading. If a variable is present in this dictionary as a
      key, it will not be deserialized and the corresponding item
      will be used instead. Similar to custom_objects in
      ``keras.models.load_model``. Useful when you have an object in
      file that can not be deserialized.
  :return: Loaded class parameters.
  """
```
**Parameter Description**:
  - `json_string`: JSON serialization of the class-parameters to load
  - `custom_objects`: Dictionary of objects to replace upon loading
**Return Value**: Loaded class parameters

#### 119. `open_path` function - Open path for reading/writing with validation
**Function**: Opens a path for reading or writing with a preferred suffix and raises debug information
**Function Signature**:
```python
@functools.singledispatch
def open_path(
    path: Union[str, pathlib.Path, io.BufferedIOBase], mode: str, verbose: int = 0, suffix: Optional[str] = None
) -> Union[io.BufferedWriter, io.BufferedReader, io.BytesIO, io.BufferedRandom]:
  """
  Opens a path for reading or writing with a preferred suffix and raises debug information.
  If the provided path is a derivative of io.BufferedIOBase it ensures that the file
  matches the provided mode, i.e. If the mode is read ("r", "read") it checks that the path is readable.
  If the mode is write ("w", "write") it checks that the file is writable.

  If the provided path is a string or a pathlib.Path, it ensures that it exists. If the mode is "read"
  it checks that it exists, if it doesn't exist it attempts to read path.suffix if a suffix is provided.
  If the mode is "write" and the path does not exist, it creates all the parent folders. If the path
  points to a folder, it changes the path to path_2. If the path already exists and verbose >= 2,
  it raises a warning.

  :param path: the path to open.
      if save_path is a str or pathlib.Path and mode is "w", single dispatch ensures that the
      path actually exists. If path is a io.BufferedIOBase the path exists.
  :param mode: how to open the file. "w"|"write" for writing, "r"|"read" for reading.
  :param verbose: Verbosity level: 0 for no output, 1 for info messages, 2 for debug messages
  :param suffix: The preferred suffix. If mode is "w" then the opened file has the suffix.
      If mode is "r" then we attempt to open the path. If an error is raised and the suffix
      is not None, we attempt to open the path with the suffix.
  :return:
  """
```
**Parameter Description**:
  - `path`: the path to open
  - `mode`: how to open the file ("w"|"write" for writing, "r"|"read" for reading)
  - `verbose`: Verbosity level (0=no output, 1=info, 2=debug)
  - `suffix`: The preferred suffix
**Return Value**: Opened file object

#### 120. `open_path_str` function - Open string path
**Function**: Open a path given by a string
**Function Signature**:
```python
@open_path.register(str)
def open_path_str(path: str, mode: str, verbose: int = 0, suffix: Optional[str] = None) -> io.BufferedIOBase:
  """
  Open a path given by a string. If writing to the path, the function ensures
  that the path exists.

  :param path: the path to open. If mode is "w" then it ensures that the path exists
      by creating the necessary folders and renaming path if it points to a folder.
  :param mode: how to open the file. "w" for writing, "r" for reading.
  :param verbose: Verbosity level: 0 for no output, 1 for info messages, 2 for debug messages
  :param suffix: The preferred suffix. If mode is "w" then the opened file has the suffix.
      If mode is "r" then we attempt to open the path. If an error is raised and the suffix
      is not None, we attempt to open the path with the suffix.
  :return:
  """
```
**Parameter Description**:
  - `path`: the path to open as string
  - `mode`: how to open the file ("w" for writing, "r" for reading)
  - `verbose`: Verbosity level (0=no output, 1=info, 2=debug)
  - `suffix`: The preferred suffix
**Return Value**: Opened file object

#### 121. `open_path_pathlib` function - Open pathlib.Path
**Function**: Open a path given by pathlib.Path
**Function Signature**:
```python
@open_path.register(pathlib.Path)
def open_path_pathlib(path: pathlib.Path, mode: str, verbose: int = 0, suffix: Optional[str] = None) -> io.BufferedIOBase:
  """
  Open a path given by a pathlib.Path. If writing to the path, the function ensures
  that the path exists.

  :param path: the path to check. If mode is "w" then it
      ensures that the path exists by creating the necessary folders and
      renaming path if it points to a folder.
  :param mode: how to open the file. "w" for writing, "r" for reading.
  :param verbose: Verbosity level: 0 for no output, 2 for indicating if path without suffix is not found when mode is "r"
  :param suffix: The preferred suffix. If mode is "w" then the opened file has the suffix.
      If mode is "r" then we attempt to open the path. If an error is raised and the suffix
      is not None, we attempt to open the path with the suffix.
  :return:
  """
```
**Parameter Description**:
  - `path`: the path to check as pathlib.Path
  - `mode`: how to open the file ("w" for writing, "r" for reading)
  - `verbose`: Verbosity level (0=no output, 2=debug)
  - `suffix`: The preferred suffix
**Return Value**: Opened file object

#### 122. `save_to_zip_file` function - Save model data to zip archive
**Function**: Save model data to a zip archive
**Function Signature**:
```python
def save_to_zip_file(save_path: Union[str, pathlib.Path, io.BufferedIOBase], data: Optional[dict[str, Any]] = None, params: Optional[dict[str, Any]] = None, pytorch_variables: Optional[dict[str, Any]] = None, verbose: int = 0) -> None:
  """
  Save model data to a zip archive.

  :param save_path: Where to store the model.
      if save_path is a str or pathlib.Path ensures that the path actually exists.
  :param data: Class parameters being stored (non-PyTorch variables)
  :param params: Model parameters being stored expected to contain an entry for every
                  state_dict with its name and the state_dict.
  :param pytorch_variables: Other PyTorch variables expected to contain name and value of the variable.
  :param verbose: Verbosity level: 0 for no output, 1 for info messages, 2 for debug messages
  """
```
**Parameter Description**:
  - `save_path`: Where to store the model
  - `data`: Class parameters being stored (non-PyTorch variables)
  - `params`: Model parameters containing state_dicts
  - `pytorch_variables`: Other PyTorch variables
  - `verbose`: Verbosity level (0=no output, 1=info, 2=debug)
**Return Value**: None

#### 123. `save_to_pkl` function - Save object to pickle file
**Function**: Save an object to path creating necessary folders
**Function Signature**:
```python
def save_to_pkl(path: Union[str, pathlib.Path, io.BufferedIOBase], obj: Any, verbose: int = 0) -> None:
  """
  Save an object to path creating the necessary folders along the way.
  If the path exists and is a directory, it will raise a warning and rename the path.
  If a suffix is provided in the path, it will use that suffix, otherwise, it will use '.pkl'.

  :param path: the path to open.
      if save_path is a str or pathlib.Path and mode is "w", single dispatch ensures that the
      path actually exists. If path is a io.BufferedIOBase the path exists.
  :param obj: The object to save.
  :param verbose: Verbosity level: 0 for no output, 1 for info messages, 2 for debug messages
  """
```
**Parameter Description**:
  - `path`: the path to save to
  - `obj`: The object to save
  - `verbose`: Verbosity level (0=no output, 1=info, 2=debug)
**Return Value**: None

#### 124. `load_from_pkl` function - Load object from pickle file
**Function**: Load an object from the path
**Function Signature**:
```python
def load_from_pkl(path: Union[str, pathlib.Path, io.BufferedIOBase], verbose: int = 0) -> Any:
  """
  Load an object from the path. If a suffix is provided in the path, it will use that suffix.
  If the path does not exist, it will attempt to load using the .pkl suffix.

  :param path: the path to open.
      if save_path is a str or pathlib.Path and mode is "w", single dispatch ensures that the
      path actually exists. If path is a io.BufferedIOBase the path exists.
  :param verbose: Verbosity level: 0 for no output, 1 for info messages, 2 for debug messages
  """
```
**Parameter Description**:
  - `path`: the path to load from
  - `verbose`: Verbosity level (0=no output, 1=info, 2=debug)
**Return Value**: Loaded object

#### 125. `load_from_zip_file` function - Load model data from zip archive
**Function**: Load model data from a .zip archive
**Function Signature**:
```python
def load_from_zip_file(load_path: Union[str, pathlib.Path, io.BufferedIOBase], load_data: bool = True, custom_objects: Optional[dict[str, Any]] = None, device: Union[th.device, str] = "auto", verbose: int = 0, print_system_info: bool = False) -> tuple[Optional[dict[str, Any]], TensorDict, Optional[TensorDict]]:
  """
  Load model data from a .zip archive

  :param load_path: Where to load the model from
  :param load_data: Whether we should load and return data
      (class parameters). Mainly used by 'load_parameters' to only load model parameters (weights)
  :param custom_objects: Dictionary of objects to replace
      upon loading. If a variable is present in this dictionary as a
      key, it will not be deserialized and the corresponding item
      will be used instead. Similar to custom_objects in
      ``keras.models.load_model``. Useful when you have an object in
      file that can not be deserialized.
  :param device: Device on which the code should run.
  :param verbose: Verbosity level: 0 for no output, 1 for info messages, 2 for debug messages
  :param print_system_info: Whether to print or not the system info
      about the saved model.
  :return: Class parameters, model state_dicts (aka "params", dict of state_dict)
      and dict of pytorch variables
  """
```
**Parameter Description**:
  - `load_path`: Where to load the model from
  - `load_data`: Whether to load and return data (class parameters)
  - `custom_objects`: Dictionary of objects to replace upon loading
  - `device`: Device on which the code should run
  - `verbose`: Verbosity level (0=no output, 1=info, 2=debug)
  - `print_system_info`: Whether to print system info about saved model
**Return Value**: Tuple of (class parameters, model state_dicts, pytorch variables)

#### 126. `BaseFeaturesExtractor` Class - Base Feature Extractor

**Function**: Base class for feature extractors that process observation spaces.

**Class Definition**:
```python
class BaseFeaturesExtractor(nn.Module):
  """
  Base class that represents a features extractor.

  :param observation_space: The observation space of the environment
  :param features_dim: Number of features extracted.
  """
  def __init__(self, observation_space: gym.Space, features_dim: int = 0) -> None:
      ...
  @property
  def features_dim(self) -> int:
      ...
```

**Key Parameters**:
- `observation_space`: The environment's observation space
- `features_dim`: Number of output features

#### 127. `FlattenExtractor` Class - Simple Flattening Extractor

**Function**: Feature extractor that flattens input observations.

**Class Definition**:
```python
class FlattenExtractor(BaseFeaturesExtractor):
  """
  Feature extract that flatten the input.
  Used as a placeholder when feature extraction is not needed.

  :param observation_space: The observation space of the environment
  """
  def __init__(self, observation_space: gym.Space) -> None:
      ...
  def forward(self, observations: th.Tensor) -> th.Tensor:
      ...
```

**Details**: Uses `nn.Flatten()` to convert multi-dimensional inputs to 1D vectors.

#### 128. `NatureCNN` Class - CNN from DQN Nature Paper

**Function**: Convolutional neural network from the DQN Nature paper for image observations.

**Class Definition**:
```python
class NatureCNN(BaseFeaturesExtractor):
  """
  CNN from DQN Nature paper:
      Mnih, Volodymyr, et al.
      "Human-level control through deep reinforcement learning."
      Nature 518.7540 (2015): 529-533.

  :param observation_space: The observation space of the environment
  :param features_dim: Number of features extracted.
      This corresponds to the number of unit for the last layer.
  :param normalized_image: Whether to assume that the image is already normalized
      or not (this disables dtype and bounds checks): when True, it only checks that
      the space is a Box and has 3 dimensions.
      Otherwise, it checks that it has expected dtype (uint8) and bounds (values in [0, 255]).
  """
  def __init__(
      self,
      observation_space: gym.Space,
      features_dim: int = 512,
      normalized_image: bool = False,
  ) -> None:
      ...
  def forward(self, observations: th.Tensor) -> th.Tensor:
      ...
```

**Key Parameters**:
- `features_dim`: Output feature dimension (default 512)
- `normalized_image`: Whether input images are already normalized

**Details**: Three convolutional layers followed by fully connected layer, designed for Atari games.

#### 129. `MlpExtractor` Class - MLP for Policy and Value Networks

**Function**: Constructs separate MLPs for policy and value networks.

**Class Definition**:
```python
class MlpExtractor(nn.Module):
  """
  Constructs an MLP that receives the output from a previous features extractor (i.e. a CNN) or directly
  the observations (if no features extractor is applied) as an input and outputs a latent representation
  for the policy and a value network.

  The ``net_arch`` parameter allows to specify the amount and size of the hidden layers.
  It can be in either of the following forms:
  1. ``dict(vf=[<list of layer sizes>], pi=[<list of layer sizes>])``: to specify the amount and size of the layers in the
      policy and value nets individually. If it is missing any of the keys (pi or vf),
      zero layers will be considered for that key.
  2. ``[<list of layer sizes>]``: "shortcut" in case the amount and size of the layers
      in the policy and value nets are the same. Same as ``dict(vf=int_list, pi=int_list)``
      where int_list is the same for the actor and critic.

  .. note::
      If a key is not specified or an empty list is passed ``[]``, a linear network will be used.

  :param feature_dim: Dimension of the feature vector (can be the output of a CNN)
  :param net_arch: The specification of the policy and value networks.
      See above for details on its formatting.
  :param activation_fn: The activation function to use for the networks.
  :param device: PyTorch device.
  """
  def __init__(
      self,
      feature_dim: int,
      net_arch: Union[list[int], dict[str, list[int]]],
      activation_fn: type[nn.Module],
      device: Union[th.device, str] = "auto",
  ) -> None:
      ...
  def forward(self, features: th.Tensor) -> tuple[th.Tensor, th.Tensor]:
      ...
  def forward_actor(self, features: th.Tensor) -> th.Tensor:
      ...
  def forward_critic(self, features: th.Tensor) -> th.Tensor:
      ...
```

**Key Parameters**:
- `feature_dim`: Input feature dimension
- `net_arch`: Architecture specification for policy/value networks
- `activation_fn`: Activation function type

**Details**: Supports shared or separate architectures for actor and critic networks.

#### 130. `CombinedExtractor` Class - Extractor for Dict Observation Spaces

**Function**: Combined features extractor for dictionary observation spaces.

**Class Definition**:
```python
class CombinedExtractor(BaseFeaturesExtractor):
  """
  Combined features extractor for Dict observation spaces.
  Builds a features extractor for each key of the space. Input from each space
  is fed through a separate submodule (CNN or MLP, depending on input shape),
  the output features are concatenated and fed through additional MLP network ("combined").

  :param observation_space:
  :param cnn_output_dim: Number of features to output from each CNN submodule(s). Defaults to
      256 to avoid exploding network sizes.
  :param normalized_image: Whether to assume that the image is already normalized
      or not (this disables dtype and bounds checks): when True, it only checks that
      the space is a Box and has 3 dimensions.
      Otherwise, it checks that it has expected dtype (uint8) and bounds (values in [0, 255]).
  """
  def __init__(
      self,
      observation_space: spaces.Dict,
      cnn_output_dim: int = 256,
      normalized_image: bool = False,
  ) -> None:
      ...
  def forward(self, observations: TensorDict) -> th.Tensor:
      ...
```

**Key Parameters**:
- `cnn_output_dim`: Output dimension for CNN submodules
- `normalized_image`: Whether images are normalized

**Details**: Processes each key in dict space with appropriate extractor (CNN or MLP) and concatenates outputs.

#### 131. `create_mlp` Function - Create Multi-Layer Perceptron

**Function**: Create a multi-layer perceptron with configurable architecture.

**Function Signature**:
```python
def create_mlp(
    input_dim: int,
    output_dim: int,
    net_arch: list[int],
    activation_fn: type[nn.Module] = nn.ReLU,
    squash_output: bool = False,
    with_bias: bool = True,
    pre_linear_modules: Optional[list[type[nn.Module]]] = None,
    post_linear_modules: Optional[list[type[nn.Module]]] = None,
) -> list[nn.Module]:
  """
  Create a multi layer perceptron (MLP), which is
  a collection of fully-connected layers each followed by an activation function.

  :param input_dim: Dimension of the input vector
  :param output_dim: Dimension of the output (last layer, for instance, the number of actions)
  :param net_arch: Architecture of the neural net
      It represents the number of units per layer.
      The length of this list is the number of layers.
  :param activation_fn: The activation function
      to use after each layer.
  :param squash_output: Whether to squash the output using a Tanh
      activation function
  :param with_bias: If set to False, the layers will not learn an additive bias
  :param pre_linear_modules: List of nn.Module to add before the linear layers.
      These modules should maintain the input tensor dimension (e.g. BatchNorm).
      The number of input features is passed to the module's constructor.
      Compared to post_linear_modules, they are used before the output layer (output_dim > 0).
  :param post_linear_modules: List of nn.Module to add after the linear layers
      (and before the activation function). These modules should maintain the input
      tensor dimension (e.g. Dropout, LayerNorm). They are not used after the
      output layer (output_dim > 0). The number of input features is passed to
      the module's constructor.
  :return: The list of layers of the neural network
  """
```

**Parameter Description**:
- `input_dim`, `output_dim`: Network input/output dimensions
- `net_arch`: Hidden layer sizes
- `activation_fn`: Activation function
- `squash_output`: Whether to apply tanh to output
- `pre_linear_modules`, `post_linear_modules`: Additional modules to insert

**Return Value**: List of PyTorch modules forming the MLP

#### 132. `get_actor_critic_arch` Function - Parse Network Architecture

**Function**: Parse network architecture specification for actor-critic algorithms.

**Function Signature**:
```python
def get_actor_critic_arch(net_arch: Union[list[int], dict[str, list[int]]]) -> tuple[list[int], list[int]]:
  """
  Get the actor and critic network architectures for off-policy actor-critic algorithms (SAC, TD3, DDPG).

  The ``net_arch`` parameter allows to specify the amount and size of the hidden layers,
  which can be different for the actor and the critic.
  It is assumed to be a list of ints or a dict.

  1. If it is a list, actor and critic networks will have the same architecture.
      The architecture is represented by a list of integers (of arbitrary length (zero allowed))
      each specifying the number of units per layer.
      If the number of ints is zero, the network will be linear.
  2. If it is a dict,  it should have the following structure:
      ``dict(qf=[<critic network architecture>], pi=[<actor network architecture>])``.
      where the network architecture is a list as described in 1.

  For example, to have actor and critic that share the same network architecture,
  you only need to specify ``net_arch=[256, 256]`` (here, two hidden layers of 256 units each).

  If you want a different architecture for the actor and the critic,
  then you can specify ``net_arch=dict(qf=[400, 300], pi=[64, 64])``.

  .. note::
      Compared to their on-policy counterparts, no shared layers (other than the features extractor)
      between the actor and the critic are allowed (to prevent issues with target networks).

  :param net_arch: The specification of the actor and critic networks.
      See above for details on its formatting.
  :return: The network architectures for the actor and the critic
  """
```

**Parameter Description**: `net_arch`: Network architecture specification

**Return Value**: Tuple of (actor_architecture, critic_architecture)

#### 133. `GymEnv` constant - Gym environment type alias
**Description**: Type alias for gym environments
**Value**: Union[gym.Env, "VecEnv"]

#### 134. `GymObs` constant - Gym observation type alias
**Description**: Type alias for gym observations
**Value**: Union[tuple, dict[str, Any], np.ndarray, int]

#### 135. `GymResetReturn` constant - Gym reset return type alias
**Description**: Type alias for gym reset return
**Value**: tuple[GymObs, dict]

#### 136. `AtariResetReturn` constant - Atari reset return type alias
**Description**: Type alias for Atari reset return
**Value**: tuple[np.ndarray, dict[str, Any]]

#### 137. `GymStepReturn` constant - Gym step return type alias
**Description**: Type alias for gym step return
**Value**: tuple[GymObs, float, bool, bool, dict]

#### 138. `AtariStepReturn` constant - Atari step return type alias
**Description**: Type alias for Atari step return
**Value**: tuple[np.ndarray, SupportsFloat, bool, bool, dict[str, Any]]

#### 139. `TensorDict` constant - Tensor dictionary type alias
**Description**: Type alias for tensor dictionaries
**Value**: dict[str, th.Tensor]

#### 140. `OptimizerStateDict` constant - Optimizer state dictionary type alias
**Description**: Type alias for optimizer state dictionaries
**Value**: dict[str, Any]

#### 141. `MaybeCallback` constant - Callback type alias
**Description**: Type alias for callback parameters
**Value**: Union[None, Callable, list["BaseCallback"], "BaseCallback"]

#### 142. `PyTorchObs` constant - PyTorch observation type alias
**Description**: Type alias for PyTorch observations
**Value**: Union[th.Tensor, TensorDict]

#### 143. `Schedule` constant - Schedule function type alias
**Description**: Type alias for schedule functions
**Value**: Callable[[float], float]

#### 144. `RolloutBufferSamples` class - Rollout buffer samples container
**Function**: Named tuple for storing rollout buffer samples
**Class Definition**:
```python
class RolloutBufferSamples(NamedTuple):
    observations: th.Tensor
    actions: th.Tensor
    old_values: th.Tensor
    old_log_prob: th.Tensor
    advantages: th.Tensor
    returns: th.Tensor
```

#### 145. `DictRolloutBufferSamples` class - Dictionary rollout buffer samples container
**Function**: Named tuple for storing dictionary rollout buffer samples
**Class Definition**:
```python
class DictRolloutBufferSamples(NamedTuple):
    observations: TensorDict
    actions: th.Tensor
    old_values: th.Tensor
    old_log_prob: th.Tensor
    advantages: th.Tensor
    returns: th.Tensor
```

#### 146. `ReplayBufferSamples` class - Replay buffer samples container
**Function**: Named tuple for storing replay buffer samples
**Class Definition**:
```python
class ReplayBufferSamples(NamedTuple):
    observations: th.Tensor
    actions: th.Tensor
    next_observations: th.Tensor
    dones: th.Tensor
    rewards: th.Tensor
    discounts: Optional[th.Tensor] = None
```

#### 147. `DictReplayBufferSamples` class - Dictionary replay buffer samples container
**Function**: Named tuple for storing dictionary replay buffer samples
**Class Definition**:
```python
class DictReplayBufferSamples(NamedTuple):
    observations: TensorDict
    actions: th.Tensor
    next_observations: TensorDict
    dones: th.Tensor
    rewards: th.Tensor
    discounts: Optional[th.Tensor] = None
```

#### 148. `RolloutReturn` class - Rollout return container
**Function**: Named tuple for storing rollout return values
**Class Definition**:
```python
class RolloutReturn(NamedTuple):
    episode_timesteps: int
    n_episodes: int
    continue_training: bool
```

#### 149. `TrainFrequencyUnit` class - Training frequency unit enumeration
**Function**: Enumeration for training frequency units
**Class Definition**:
```python
class TrainFrequencyUnit(Enum):
    STEP = "step"
    EPISODE = "episode"
```

#### 150. `TrainFreq` class - Training frequency container
**Function**: Named tuple for storing training frequency configuration
**Class Definition**:
```python
class TrainFreq(NamedTuple):
    frequency: int
    unit: TrainFrequencyUnit
```

#### 151. `PolicyPredictor` class - Policy predictor protocol
**Function**: Protocol defining the interface for policy predictors
**Class Definition**:
```python
class PolicyPredictor(Protocol):
    def predict(
        self,
        observation: Union[np.ndarray, dict[str, np.ndarray]],
        state: Optional[tuple[np.ndarray, ...]] = None,
        episode_start: Optional[np.ndarray] = None,
        deterministic: bool = False,
    ) -> tuple[np.ndarray, Optional[tuple[np.ndarray, ...]]]:
        """
        Get the policy action from an observation (and optional hidden state).
        Includes sugar-coating to handle different observations (e.g. normalizing images).

        :param observation: the input observation
        :param state: The last hidden states (can be None, used in recurrent policies)
        :param episode_start: The last masks (can be None, used in recurrent policies)
            this correspond to beginning of episodes,
            where the hidden states of the RNN must be reset.
        :param deterministic: Whether or not to return deterministic actions.
        :return: the model's action and the next hidden state
            (used in recurrent policies)
        """
```

**Methods**:

- `predict(observation, state=None, episode_start=None, deterministic=False)`:
  - **Function**: Get the policy action from an observation (and optional hidden state)
  - **Parameters**:
    - `observation`: the input observation
    - `state`: The last hidden states (can be None, used in recurrent policies)
    - `episode_start`: The last masks (can be None, used in recurrent policies)
    - `deterministic`: Whether or not to return deterministic actions
  - **Return Value**: the model's action and the next hidden state

#### 152. `set_random_seed` function - Seed random generators
**Function**: Seed the different random generators
**Function Signature**:
```python
def set_random_seed(seed: int, using_cuda: bool = False) -> None:
  """
  Seed the different random generators.

  :param seed:
  :param using_cuda:
  """

```
**Parameter Description**:
  - `seed`: Seed value
  - `using_cuda`: Whether using CUDA
**Return Value**: None

#### 153. `explained_variance` function - Compute explained variance
**Function**: Computes fraction of variance that ypred explains about y
**Function Signature**:
```python
def explained_variance(y_pred: np.ndarray, y_true: np.ndarray) -> float:
  """
  Computes fraction of variance that ypred explains about y.
  Returns 1 - Var[y-ypred] / Var[y]

  interpretation:
      ev=0  =>  might as well have predicted zero
      ev=1  =>  perfect prediction
      ev<0  =>  worse than just predicting zero

  :param y_pred: the prediction
  :param y_true: the expected value
  :return: explained variance of ypred and y
  """
```
**Parameter Description**:
  - `y_pred`: the prediction
  - `y_true`: the expected value
**Return Value**: explained variance of ypred and y

#### 154. `update_learning_rate` function - Update optimizer learning rate
**Function**: Update the learning rate for a given optimizer
**Function Signature**:
```python
def update_learning_rate(optimizer: th.optim.Optimizer, learning_rate: float) -> None:
  """
  Update the learning rate for a given optimizer.
  Useful when doing linear schedule.

  :param optimizer: Pytorch optimizer
  :param learning_rate: New learning rate value
  """
```
**Parameter Description**:
  - `optimizer`: Pytorch optimizer
  - `learning_rate`: New learning rate value
**Return Value**: None

#### 155. `FloatSchedule` class - Float schedule wrapper
**Function**: Wrapper that ensures the output of a Schedule is cast to float
**Class Definition**:
```python
class FloatSchedule:
  """
  Wrapper that ensures the output of a Schedule is cast to float.
  Can wrap either a constant value or an existing callable Schedule.

  :param value_schedule: Constant value or callable schedule
          (e.g. LinearSchedule, ConstantSchedule)
  """
  def __init__(self, value_schedule: Union[Schedule, float]): ...
  def __call__(self, progress_remaining: float) -> float: ...
  def __repr__(self) -> str: ...
```
**Methods**:

- `__init__(value_schedule)`:
  - **Function**: Initialize float schedule
  - **Parameters**:
    - `value_schedule`: Constant value or callable schedule

- `__call__(progress_remaining)`:
  - **Function**: Call the schedule and cast output to float
  - **Parameters**:
    - `progress_remaining`: Remaining progress
  - **Return Value**: Schedule output as float

- `__repr__()`:
  - **Function**: String representation
  - **Return Value**: String representation of the schedule

#### 156. `LinearSchedule` class - Linear interpolation schedule
**Function**: LinearSchedule interpolates linearly between start and end
**Class Definition**:
```python
class LinearSchedule:
  """
  LinearSchedule interpolates linearly between start and end
  between ``progress_remaining`` = 1 and ``progress_remaining`` = ``end_fraction``.
  This is used in DQN for linearly annealing the exploration fraction
  (epsilon for the epsilon-greedy strategy).

  :param start: value to start with if ``progress_remaining`` = 1
  :param end: value to end with if ``progress_remaining`` = 0
  :param end_fraction: fraction of ``progress_remaining``  where end is reached e.g 0.1
      then end is reached after 10% of the complete training process.
  """
  def __init__(self, start: float, end: float, end_fraction: float) -> None: ...
  def __call__(self, progress_remaining: float) -> float: ...
  def __repr__(self) -> str: ...
```
**Methods**:

- `__init__(start, end, end_fraction)`:
  - **Function**: Initialize linear schedule
  - **Parameters**:
    - `start`: value to start with if progress_remaining = 1
    - `end`: value to end with if progress_remaining = 0
    - `end_fraction`: fraction where end is reached

- `__call__(progress_remaining)`:
  - **Function**: Compute linear interpolated value
  - **Parameters**:
    - `progress_remaining`: Remaining progress
  - **Return Value**: Interpolated value

- `__repr__()`:
  - **Function**: String representation
  - **Return Value**: String representation of the schedule

#### 157. `ConstantSchedule` class - Constant value schedule
**Function**: Constant schedule that always returns the same value
**Class Definition**:
```python
class ConstantSchedule:
  """
  Constant schedule that always returns the same value.
  Useful for fixed learning rates or clip ranges.

  :param val: constant value
  """
  def __init__(self, val: float): ...
  def __call__(self, _: float) -> float: ...
  def __repr__(self) -> str: ...
```
**Methods**:

- `__init__(val)`:
  - **Function**: Initialize constant schedule
  - **Parameters**:
    - `val`: constant value

- `__call__(_)`:
  - **Function**: Return constant value
  - **Return Value**: Constant value

- `__repr__()`:
  - **Function**: String representation
  - **Return Value**: String representation of the schedule

#### 158. `get_schedule_fn` function - Get schedule function (deprecated)
**Function**: Transform learning rate and clip range to callable (deprecated)
**Function Signature**:
```python
def get_schedule_fn(value_schedule: Union[Schedule, float]) -> Schedule:
  """
  Transform (if needed) learning rate and clip range (for PPO)
  to callable.

  :param value_schedule: Constant value of schedule function
  :return: Schedule function (can return constant value)
  """
```
**Parameter Description**:
  - `value_schedule`: Constant value of schedule function
**Return Value**: Schedule function

#### 159. `get_linear_fn` function - Create linear function (deprecated)
**Function**: Create linear interpolation function (deprecated)
**Function Signature**:
```python
def get_linear_fn(start: float, end: float, end_fraction: float) -> Schedule:
  """
  Create a function that interpolates linearly between start and end
  between ``progress_remaining`` = 1 and ``progress_remaining`` = ``end_fraction``.
  This is used in DQN for linearly annealing the exploration fraction
  (epsilon for the epsilon-greedy strategy).

  :params start: value to start with if ``progress_remaining`` = 1
  :params end: value to end with if ``progress_remaining`` = 0
  :params end_fraction: fraction of ``progress_remaining``
      where end is reached e.g 0.1 then end is reached after 10%
      of the complete training process.
  :return: Linear schedule function.
  """
```
**Parameter Description**:
  - `start`: value to start with
  - `end`: value to end with
  - `end_fraction`: fraction where end is reached
**Return Value**: Linear schedule function

#### 160. `constant_fn` function - Create constant function (deprecated)
**Function**: Create function that returns constant (deprecated)
**Function Signature**:
```python
def constant_fn(val: float) -> Schedule:
  """
  Create a function that returns a constant
  It is useful for learning rate schedule (to avoid code duplication)

  :param val: constant value
  :return: Constant schedule function.
  """
```
**Parameter Description**:
  - `val`: constant value
**Return Value**: Constant schedule function

#### 161. `get_device` function - Retrieve PyTorch device
**Function**: Retrieve PyTorch device, checking availability
**Function Signature**:
```python
def get_device(device: Union[th.device, str] = "auto") -> th.device:
  """
  Retrieve PyTorch device.
  It checks that the requested device is available first.
  For now, it supports only cpu and cuda.
  By default, it tries to use the gpu.

  :param device: One for 'auto', 'cuda', 'cpu'
  :return: Supported Pytorch device
  """
```
**Parameter Description**:
  - `device`: One for 'auto', 'cuda', 'cpu'
**Return Value**: Supported Pytorch device

#### 162. `get_latest_run_id` function - Get latest run ID
**Function**: Returns the latest run number for given log name and path
**Function Signature**:
```python
def get_latest_run_id(log_path: str = "", log_name: str = "") -> int:
  """
  Returns the latest run number for the given log name and log path,
  by finding the greatest number in the directories.

  :param log_path: Path to the log folder containing several runs.
  :param log_name: Name of the experiment. Each run is stored
      in a folder named ``log_name_1``, ``log_name_2``, ...
  :return: latest run number
  """
```
**Parameter Description**:
  - `log_path`: Path to the log folder
  - `log_name`: Name of the experiment
**Return Value**: latest run number

#### 163. `configure_logger` function - Configure logger outputs
**Function**: Configure the logger's outputs
**Function Signature**:
```python
def configure_logger(verbose: int = 0, tensorboard_log: Optional[str] = None, tb_log_name: str = "", reset_num_timesteps: bool = True) -> Logger:
  """
  Configure the logger's outputs.

  :param verbose: Verbosity level: 0 for no output, 1 for the standard output to be part of the logger outputs
  :param tensorboard_log: the log location for tensorboard (if None, no logging)
  :param tb_log_name: tensorboard log
  :param reset_num_timesteps:  Whether the ``num_timesteps`` attribute is reset or not.
      It allows to continue a previous learning curve (``reset_num_timesteps=False``)
      or start from t=0 (``reset_num_timesteps=True``, the default).
  :return: The logger object
  """
```
**Parameter Description**:
  - `verbose`: Verbosity level
  - `tensorboard_log`: log location for tensorboard
  - `tb_log_name`: tensorboard log name
  - `reset_num_timesteps`: Whether to reset num_timesteps attribute
**Return Value**: The logger object

#### 164. `check_for_correct_spaces` function - Check environment spaces
**Function**: Checks that environment has same spaces as provided ones
**Function Signature**:
```python
def check_for_correct_spaces(env: GymEnv, observation_space: spaces.Space, action_space: spaces.Space) -> None:
  """
  Checks that the environment has same spaces as provided ones. Used by BaseAlgorithm to check if
  spaces match after loading the model with given env.
  Checked parameters:
  - observation_space
  - action_space

  :param env: Environment to check for valid spaces
  :param observation_space: Observation space to check against
  :param action_space: Action space to check against
  """
```
**Parameter Description**:
  - `env`: Environment to check
  - `observation_space`: Observation space to check against
  - `action_space`: Action space to check against
**Return Value**: None

#### 165. `check_shape_equal` function - Check space shapes equality
**Function**: Check that spaces have the same shape
**Function Signature**:
```python
def check_shape_equal(space1: spaces.Space, space2: spaces.Space) -> None:
  """
  If the spaces are Box, check that they have the same shape.

  If the spaces are Dict, it recursively checks the subspaces.

  :param space1: Space
  :param space2: Other space
  """
```
**Parameter Description**:
  - `space1`: Space
  - `space2`: Other space
**Return Value**: None

#### 166. `is_vectorized_box_observation` function - Check box observation vectorization
**Function**: Detect and validate box observation shape for vectorization
**Function Signature**:
```python
def is_vectorized_box_observation(observation: np.ndarray, observation_space: spaces.Box) -> bool:
  """
  For box observation type, detects and validates the shape,
  then returns whether or not the observation is vectorized.

  :param observation: the input observation to validate
  :param observation_space: the observation space
  :return: whether the given observation is vectorized or not
  """
```
**Parameter Description**:
  - `observation`: the input observation to validate
  - `observation_space`: the observation space
**Return Value**: whether the observation is vectorized

#### 167. `is_vectorized_discrete_observation` function - Check discrete observation vectorization
**Function**: Detect and validate discrete observation shape for vectorization
**Function Signature**:
```python
def is_vectorized_discrete_observation(observation: Union[int, np.ndarray], observation_space: spaces.Discrete) -> bool
```
**Parameter Description**:
  - `observation`: the input observation to validate
  - `observation_space`: the observation space
**Return Value**: whether the observation is vectorized

#### 168. `is_vectorized_multidiscrete_observation` function - Check multidiscrete observation vectorization
**Function**: Detect and validate multidiscrete observation shape for vectorization
**Function Signature**:
```python
def is_vectorized_multidiscrete_observation(observation: np.ndarray, observation_space: spaces.MultiDiscrete) -> bool:
  """
  For multidiscrete observation type, detects and validates the shape,
  then returns whether or not the observation is vectorized.

  :param observation: the input observation to validate
  :param observation_space: the observation space
  :return: whether the given observation is vectorized or not
  """
```
**Parameter Description**:
  - `observation`: the input observation to validate
  - `observation_space`: the observation space
**Return Value**: whether the observation is vectorized

#### 169. `is_vectorized_multibinary_observation` function - Check multibinary observation vectorization
**Function**: Detect and validate multibinary observation shape for vectorization
**Function Signature**:
```python
def is_vectorized_multibinary_observation(observation: np.ndarray, observation_space: spaces.MultiBinary) -> bool:
  """
  For multibinary observation type, detects and validates the shape,
  then returns whether or not the observation is vectorized.

  :param observation: the input observation to validate
  :param observation_space: the observation space
  :return: whether the given observation is vectorized or not
  """
```
**Parameter Description**:
  - `observation`: the input observation to validate
  - `observation_space`: the observation space
**Return Value**: whether the observation is vectorized

#### 170. `is_vectorized_dict_observation` function - Check dict observation vectorization
**Function**: Detect and validate dict observation shape for vectorization
**Function Signature**:
```python
def is_vectorized_dict_observation(observation: np.ndarray, observation_space: spaces.Dict) -> bool:
  """
  For dict observation type, detects and validates the shape,
  then returns whether or not the observation is vectorized.

  :param observation: the input observation to validate
  :param observation_space: the observation space
  :return: whether the given observation is vectorized or not
  """

```
**Parameter Description**:
  - `observation`: the input observation to validate
  - `observation_space`: the observation space
**Return Value**: whether the observation is vectorized

#### 171. `is_vectorized_observation` function - Check observation vectorization
**Function**: Detect and validate observation shape for vectorization
**Function Signature**:
```python
def is_vectorized_observation(observation: Union[int, np.ndarray], observation_space: spaces.Space) -> bool:
  """
  For every observation type, detects and validates the shape,
  then returns whether or not the observation is vectorized.

  :param observation: the input observation to validate
  :param observation_space: the observation space
  :return: whether the given observation is vectorized or not
  """
```
**Parameter Description**:
  - `observation`: the input observation to validate
  - `observation_space`: the observation space
**Return Value**: whether the observation is vectorized

#### 172. `safe_mean` function - Compute safe mean
**Function**: Compute mean of array if elements exist, else return NaN
**Function Signature**:
```python
def safe_mean(arr: Union[np.ndarray, list, deque]) -> float:
  """
  Compute the mean of an array if there is at least one element.
  For empty array, return NaN. It is used for logging only.

  :param arr: Numpy array or list of values
  :return:
  """
```
**Parameter Description**:
  - `arr`: Numpy array or list of values
**Return Value**: Mean value or NaN

#### 173. `get_parameters_by_name` function - Extract parameters by name
**Function**: Extract parameters from state dict if name contains included strings
**Function Signature**:
```python
def get_parameters_by_name(model: th.nn.Module, included_names: Iterable[str]) -> list[th.Tensor]:
  """
  Extract parameters from the state dict of ``model``
  if the name contains one of the strings in ``included_names``.

  :param model: the model where the parameters come from.
  :param included_names: substrings of names to include.
  :return: List of parameters values (Pytorch tensors)
      that matches the queried names.
  """
```
**Parameter Description**:
  - `model`: the model where parameters come from
  - `included_names`: substrings of names to include
**Return Value**: List of parameter values

#### 174. `zip_strict` function - Strict zip function
**Function**: zip() function but enforces equal length iterables
**Function Signature**:
```python
def zip_strict(*iterables: Iterable) -> Iterable:
  """
  ``zip()`` function but enforces that iterables are of equal length.
  Raises ``ValueError`` if iterables not of equal length.
  Code inspired by Stackoverflow answer for question #32954486.

  :param \*iterables: iterables to ``zip()``
  """
```
**Parameter Description**:
  - `*iterables`: iterables to zip
**Return Value**: Zipped iterables

#### 175. `polyak_update` function - Polyak average update
**Function**: Perform Polyak average update on target parameters
**Function Signature**:
```python
def polyak_update(params: Iterable[th.Tensor], target_params: Iterable[th.Tensor], tau: float) -> None:
  """
  Perform a Polyak average update on ``target_params`` using ``params``:
  target parameters are slowly updated towards the main parameters.
  ``tau``, the soft update coefficient controls the interpolation:
  ``tau=1`` corresponds to copying the parameters to the target ones whereas nothing happens when ``tau=0``.
  The Polyak update is done in place, with ``no_grad``, and therefore does not create intermediate tensors,
  or a computation graph, reducing memory cost and improving performance.  We scale the target params
  by ``1-tau`` (in-place), add the new weights, scaled by ``tau`` and store the result of the sum in the target
  params (in place).
  See https://github.com/DLR-RM/stable-baselines3/issues/93

  :param params: parameters to use to update the target params
  :param target_params: parameters to update
  :param tau: the soft update coefficient ("Polyak update", between 0 and 1)
  """
```
**Parameter Description**:
  - `params`: parameters to update target params
  - `target_params`: parameters to update
  - `tau`: soft update coefficient
**Return Value**: None

#### 176. `obs_as_tensor` function - Convert observation to tensor
**Function**: Move observation to given device
**Function Signature**:
```python
def obs_as_tensor(obs: Union[np.ndarray, dict[str, np.ndarray]], device: th.device) -> Union[th.Tensor, TensorDict]:
  """
  Moves the observation to the given device.

  :param obs:
  :param device: PyTorch device
  :return: PyTorch tensor of the observation on a desired device.
  """
```
**Parameter Description**:
  - `obs`: observation data
  - `device`: PyTorch device
**Return Value**: PyTorch tensor of observation

#### 177. `should_collect_more_steps` function - Determine collection termination
**Function**: Determine termination condition for experience collection
**Function Signature**:
```python
def should_collect_more_steps(train_freq: TrainFreq, num_collected_steps: int, num_collected_episodes: int) -> bool:
  """
  Helper used in ``collect_rollouts()`` of off-policy algorithms
  to determine the termination condition.

  :param train_freq: How much experience should be collected before updating the policy.
  :param num_collected_steps: The number of already collected steps.
  :param num_collected_episodes: The number of already collected episodes.
  :return: Whether to continue or not collecting experience
      by doing rollouts of the current policy.
  """
```
**Parameter Description**:
  - `train_freq`: How much experience to collect before update
  - `num_collected_steps`: Number of collected steps
  - `num_collected_episodes`: Number of collected episodes
**Return Value**: Whether to continue collecting experience

#### 178. `get_system_info` function - Retrieve system information
**Function**: Retrieve system and python env info
**Function Signature**:
```python
def get_system_info(print_info: bool = True) -> tuple[dict[str, str], str]:
  """
  Retrieve system and python env info for the current system.

  :param print_info: Whether to print or not those infos
  :return: Dictionary summing up the version for each relevant package
      and a formatted string.
  """
```
**Parameter Description**:
  - `print_info`: Whether to print info
**Return Value**: Dictionary of package versions and formatted string

#### 179. `DDPG` Class - Deep Deterministic Policy Gradient Algorithm

**Function**: Deep Deterministic Policy Gradient algorithm for continuous control tasks, implemented as a special case of TD3.

**Class Definition**:

```python
class DDPG(TD3):
    def __init__(
        self,
        policy: Union[str, type[TD3Policy]],
        env: Union[GymEnv, str],
        learning_rate: Union[float, Schedule] = 1e-3,
        buffer_size: int = 1_000_000,
        learning_starts: int = 100,
        batch_size: int = 256,
        tau: float = 0.005,
        gamma: float = 0.99,
        train_freq: Union[int, tuple[int, str]] = 1,
        gradient_steps: int = 1,
        action_noise: Optional[ActionNoise] = None,
        replay_buffer_class: Optional[type[ReplayBuffer]] = None,
        replay_buffer_kwargs: Optional[dict[str, Any]] = None,
        optimize_memory_usage: bool = False,
        n_steps: int = 1,
        tensorboard_log: Optional[str] = None,
        policy_kwargs: Optional[dict[str, Any]] = None,
        verbose: int = 0,
        seed: Optional[int] = None,
        device: Union[th.device, str] = "auto",
        _init_setup_model: bool = True,
    ):
        ...
    def learn(
        self: SelfDDPG,
        total_timesteps: int,
        callback: MaybeCallback = None,
        log_interval: int = 4,
        tb_log_name: str = "DDPG",
        reset_num_timesteps: bool = True,
        progress_bar: bool = False,
    ) -> SelfDDPG:
        ...
```

**Key Parameters**:
- `learning_rate`: Learning rate for all networks (1e-3 default)
- `buffer_size`: Replay buffer size (1M default)
- `batch_size`: Minibatch size for updates (256 default)
- `tau`: Target network soft update coefficient (0.005 default)
- `gamma`: Discount factor (0.99 default)
- `action_noise`: Exploration noise for continuous action spaces

**Core Methods**:

- `__init__()`:
  - **Function**: Initialize DDPG algorithm with specified parameters.
  - **Details**: Inherits from TD3 but disables TD3-specific tricks (delayed policy updates, target policy smoothing) to implement vanilla DDPG. Uses single critic by default.

- `learn()`:
  - **Function**: Train the DDPG agent for specified number of timesteps.
  - **Parameters**:
    - `total_timesteps`: Total training timesteps
    - `callback`: Training callbacks
    - `log_interval`: Logging frequency
    - `tb_log_name`: Tensorboard run name
  - **Return Value**: The trained DDPG instance.
  - **Details**: Inherits training loop from TD3 base class with DDPG-specific configuration.



#### 180. `HerReplayBuffer` class - Hindsight Experience Replay buffer
**Function**: Replay buffer for sampling HER (Hindsight Experience Replay) transitions
**Class Definition**:
```python
class HerReplayBuffer(DictReplayBuffer):
    def __init__(
        self,
        buffer_size: int,
        observation_space: spaces.Dict,
        action_space: spaces.Space,
        env: VecEnv,
        device: Union[th.device, str] = "auto",
        n_envs: int = 1,
        optimize_memory_usage: bool = False,
        handle_timeout_termination: bool = True,
        n_sampled_goal: int = 4,
        goal_selection_strategy: Union[GoalSelectionStrategy, str] = "future",
        copy_info_dict: bool = False,
    ): ...
    def __getstate__(self) -> dict[str, Any]: ...
    def __setstate__(self, state: dict[str, Any]) -> None: ...
    def set_env(self, env: VecEnv) -> None: ...
    def add(
        self,
        obs: dict[str, np.ndarray],
        next_obs: dict[str, np.ndarray],
        action: np.ndarray,
        reward: np.ndarray,
        done: np.ndarray,
        infos: list[dict[str, Any]],
    ) -> None: ...
    def _compute_episode_length(self, env_idx: int) -> None: ...
    def sample(self, batch_size: int, env: Optional[VecNormalize] = None) -> DictReplayBufferSamples: ...
    def _get_real_samples(
        self,
        batch_indices: np.ndarray,
        env_indices: np.ndarray,
        env: Optional[VecNormalize] = None,
    ) -> DictReplayBufferSamples: ...
    def _get_virtual_samples(
        self,
        batch_indices: np.ndarray,
        env_indices: np.ndarray,
        env: Optional[VecNormalize] = None,
    ) -> DictReplayBufferSamples: ...
    def _sample_goals(self, batch_indices: np.ndarray, env_indices: np.ndarray) -> np.ndarray: ...
    def truncate_last_trajectory(self) -> None: ...
```

**Key Parameters**:
  - `buffer_size`: Max number of element in the buffer
  - `observation_space`: Observation space
  - `action_space`: Action space
  - `env`: The training environment
  - `n_sampled_goal`: Number of virtual transitions to create per real transition
  - `goal_selection_strategy`: Strategy for sampling goals for replay

**Methods**:

- `__init__(buffer_size, observation_space, action_space, env, device, n_envs, optimize_memory_usage, handle_timeout_termination, n_sampled_goal, goal_selection_strategy, copy_info_dict)`:
  - **Function**: Initialize HER replay buffer
  - **Parameters**:
    - `buffer_size`: Max number of element in the buffer
    - `observation_space`: Observation space
    - `action_space`: Action space
    - `env`: The training environment
    - `device`: PyTorch device
    - `n_envs`: Number of parallel environments
    - `optimize_memory_usage`: Enable memory efficient variant
    - `handle_timeout_termination`: Handle timeout termination separately
    - `n_sampled_goal`: Number of virtual transitions per real transition
    - `goal_selection_strategy`: Strategy for sampling goals
    - `copy_info_dict`: Whether to copy info dictionary for compute_reward
  - **Details**:
    - Converts goal_selection_strategy to GoalSelectionStrategy enum
    - Computes HER ratio for sampling
    - Initializes episode tracking arrays

- `__getstate__()`:
  - **Function**: Gets state for pickling (excludes env)
  - **Return Value**: Pickleable state dictionary

- `__setstate__(state)`:
  - **Function**: Restores pickled state (requires calling set_env afterwards)
  - **Parameters**:
    - `state`: Pickled state dictionary

- `set_env(env)`:
  - **Function**: Sets the environment after unpickling
  - **Parameters**:
    - `env`: VecEnv environment

- `add(obs, next_obs, action, reward, done, infos)`:
  - **Function**: Add new transition to the buffer
  - **Parameters**:
    - `obs`: Current observation
    - `next_obs`: Next observation
    - `action`: Action taken
    - `reward`: Reward received
    - `done`: Done flag
    - `infos`: Info dictionaries
  - **Details**:
    - Handles episode rewriting when buffer is full
    - Updates episode start positions
    - Stores info dictionaries if copy_info_dict is True

- `_compute_episode_length(env_idx)`:
  - **Function**: Compute and store episode length for environment
  - **Parameters**:
    - `env_idx`: Index of the environment
  - **Details**:
    - Handles circular buffer wrapping

- `sample(batch_size, env)`:
  - **Function**: Sample elements from replay buffer
  - **Parameters**:
    - `batch_size`: Number of elements to sample
    - `env`: VecEnv for normalizing observations/rewards
  - **Return Value**: DictReplayBufferSamples containing real and virtual transitions
  - **Details**:
    - Samples both real and virtual transitions based on HER ratio
    - Combines real and virtual data

- `_get_real_samples(batch_indices, env_indices, env)`:
  - **Function**: Get samples corresponding to batch and environment indices
  - **Parameters**:
    - `batch_indices`: Indices of transitions
    - `env_indices`: Indices of environments
    - `env`: VecEnv for normalization
  - **Return Value**: DictReplayBufferSamples with real transitions

- `_get_virtual_samples(batch_indices, env_indices, env)`:
  - **Function**: Get samples with new desired goals and computed rewards
  - **Parameters**:
    - `batch_indices`: Indices of transitions
    - `env_indices`: Indices of environments
    - `env`: VecEnv for normalization
  - **Return Value**: DictReplayBufferSamples with virtual transitions
  - **Details**:
    - Samples new goals based on strategy
    - Computes new rewards using environment's compute_reward method

- `_sample_goals(batch_indices, env_indices)`:
  - **Function**: Sample goals based on goal_selection_strategy
  - **Parameters**:
    - `batch_indices`: Indices of transitions
    - `env_indices`: Indices of environments
  - **Return Value**: Sampled goals
  - **Details**:
    - Supports FINAL, FUTURE, and EPISODE strategies

- `truncate_last_trajectory()`:
  - **Function**: Truncate last trajectory in replay buffer
  - **Details**:
    - Marks last transitions as done
    - Updates episode lengths for unfinished episodes

#### 181. `SAC` class - Soft Actor-Critic algorithm
**Function**: Off-Policy Maximum Entropy Deep Reinforcement Learning with a Stochastic Actor
**Class Definition**:
```python
class SAC(OffPolicyAlgorithm):
    policy_aliases: ClassVar[dict[str, type[BasePolicy]]] = {
        "MlpPolicy": MlpPolicy,
        "CnnPolicy": CnnPolicy,
        "MultiInputPolicy": MultiInputPolicy,
    }
    policy: SACPolicy
    actor: Actor
    critic: ContinuousCritic
    critic_target: ContinuousCritic

    def __init__(
        self,
        policy: Union[str, type[SACPolicy]],
        env: Union[GymEnv, str],
        learning_rate: Union[float, Schedule] = 3e-4,
        buffer_size: int = 1_000_000,
        learning_starts: int = 100,
        batch_size: int = 256,
        tau: float = 0.005,
        gamma: float = 0.99,
        train_freq: Union[int, tuple[int, str]] = 1,
        gradient_steps: int = 1,
        action_noise: Optional[ActionNoise] = None,
        replay_buffer_class: Optional[type[ReplayBuffer]] = None,
        replay_buffer_kwargs: Optional[dict[str, Any]] = None,
        optimize_memory_usage: bool = False,
        n_steps: int = 1,
        ent_coef: Union[str, float] = "auto",
        target_update_interval: int = 1,
        target_entropy: Union[str, float] = "auto",
        use_sde: bool = False,
        sde_sample_freq: int = -1,
        use_sde_at_warmup: bool = False,
        stats_window_size: int = 100,
        tensorboard_log: Optional[str] = None,
        policy_kwargs: Optional[dict[str, Any]] = None,
        verbose: int = 0,
        seed: Optional[int] = None,
        device: Union[th.device, str] = "auto",
        _init_setup_model: bool = True,
    ): ...
    def _setup_model(self) -> None: ...
    def _create_aliases(self) -> None: ...
    def train(self, gradient_steps: int, batch_size: int = 64) -> None: ...
    def learn(
        self: SelfSAC,
        total_timesteps: int,
        callback: MaybeCallback = None,
        log_interval: int = 4,
        tb_log_name: str = "SAC",
        reset_num_timesteps: bool = True,
        progress_bar: bool = False,
    ) -> SelfSAC: ...
    def _excluded_save_params(self) -> list[str]: ...
    def _get_torch_save_params(self) -> tuple[list[str], list[str]]: ...
```

**Key Parameters**:
  - `policy`: The policy model to use (MlpPolicy, CnnPolicy, ...)
  - `env`: The environment to learn from
  - `learning_rate`: learning rate for adam optimizer
  - `buffer_size`: size of the replay buffer
  - `ent_coef`: Entropy regularization coefficient
  - `target_entropy`: target entropy when learning ent_coef
  - `use_sde`: Whether to use generalized State Dependent Exploration

**Methods**:

- `__init__(policy, env, learning_rate, buffer_size, learning_starts, batch_size, tau, gamma, train_freq, gradient_steps, action_noise, replay_buffer_class, replay_buffer_kwargs, optimize_memory_usage, n_steps, ent_coef, target_update_interval, target_entropy, use_sde, sde_sample_freq, use_sde_at_warmup, stats_window_size, tensorboard_log, policy_kwargs, verbose, seed, device, _init_setup_model)`:
  - **Function**: Initialize SAC algorithm
  - **Parameters**:
    - `policy`: The policy model to use
    - `env`: The environment to learn from
    - `learning_rate`: learning rate for all networks
    - `buffer_size`: size of the replay buffer
    - `learning_starts`: steps to collect before learning starts
    - `batch_size`: Minibatch size for gradient updates
    - `tau`: soft update coefficient
    - `gamma`: discount factor
    - `train_freq`: model update frequency
    - `gradient_steps`: gradient steps after each rollout
    - `action_noise`: action noise type
    - `replay_buffer_class`: replay buffer class to use
    - `replay_buffer_kwargs`: keyword arguments for replay buffer
    - `optimize_memory_usage`: enable memory efficient replay buffer
    - `n_steps`: uses n-step return when n_step > 1
    - `ent_coef`: entropy regularization coefficient
    - `target_update_interval`: target network update frequency
    - `target_entropy`: target entropy for automatic ent_coef learning
    - `use_sde`: use generalized State Dependent Exploration
    - `sde_sample_freq`: noise matrix sampling frequency for gSDE
    - `use_sde_at_warmup`: use gSDE during warm up phase
    - `stats_window_size`: window size for rollout logging
    - `tensorboard_log`: log location for tensorboard
    - `policy_kwargs`: additional policy arguments
    - `verbose`: verbosity level
    - `seed`: random seed
    - `device`: device to run code on
    - `_init_setup_model`: whether to build network at creation
  - **Details**:
    - Inherits from OffPolicyAlgorithm
    - Supports Box action spaces and multi-environment training

- `_setup_model()`:
  - **Function**: Set up model components
  - **Details**:
    - Creates actor, critic, and critic target aliases
    - Sets up automatic target entropy calculation
    - Initializes entropy coefficient optimization if needed

- `_create_aliases()`:
  - **Function**: Create aliases for policy components
  - **Details**:
    - Sets actor, critic, and critic_target from policy

- `train(gradient_steps, batch_size=64)`:
  - **Function**: Perform SAC training for given gradient steps
  - **Parameters**:
    - `gradient_steps`: number of gradient steps to perform
    - `batch_size`: minibatch size for sampling
  - **Details**:
    - Updates learning rates for optimizers
    - Samples from replay buffer
    - Computes entropy coefficient loss if learning automatically
    - Computes critic loss using target Q-values
    - Computes actor loss with entropy regularization
    - Updates target networks periodically
    - Logs training metrics

- `learn(total_timesteps, callback=None, log_interval=4, tb_log_name="SAC", reset_num_timesteps=True, progress_bar=False)`:
  - **Function**: Train the SAC model
  - **Parameters**:
    - `total_timesteps`: total number of timesteps to train
    - `callback`: callback functions
    - `log_interval`: logging interval
    - `tb_log_name`: tensorboard log name
    - `reset_num_timesteps`: whether to reset timestep counter
    - `progress_bar`: whether to show progress bar
  - **Return Value**: Self reference for method chaining

- `_excluded_save_params()`:
  - **Function**: Get parameters to exclude from saving
  - **Return Value**: List of parameter names to exclude

- `_get_torch_save_params()`:
  - **Function**: Get PyTorch parameters to save
  - **Return Value**: Tuple of state_dict names and saved variables

#### 182. `LOG_STD_MAX` constant - Maximum log standard deviation
**Description**: Maximum value for log standard deviation in actor network
**Value**: 2

#### 183. `LOG_STD_MIN` constant - Minimum log standard deviation
**Description**: Minimum value for log standard deviation in actor network
**Value**: -20

#### 184. `Actor` class - Actor network for SAC
**Function**: Actor network (policy) for SAC
**Class Definition**:
```python
class Actor(BasePolicy):
  """
  Actor network (policy) for SAC.

  :param observation_space: Observation space
  :param action_space: Action space
  :param net_arch: Network architecture
  :param features_extractor: Network to extract features
      (a CNN when using images, a nn.Flatten() layer otherwise)
  :param features_dim: Number of features
  :param activation_fn: Activation function
  :param use_sde: Whether to use State Dependent Exploration or not
  :param log_std_init: Initial value for the log standard deviation
  :param full_std: Whether to use (n_features x n_actions) parameters
      for the std instead of only (n_features,) when using gSDE.
  :param use_expln: Use ``expln()`` function instead of ``exp()`` when using gSDE to ensure
      a positive standard deviation (cf paper). It allows to keep variance
      above zero and prevent it from growing too fast. In practice, ``exp()`` is usually enough.
  :param clip_mean: Clip the mean output when using gSDE to avoid numerical instability.
  :param normalize_images: Whether to normalize images or not,
        dividing by 255.0 (True by default)
  """
  action_space: spaces.Box

  def __init__(
      self,
      observation_space: spaces.Space,
      action_space: spaces.Box,
      net_arch: list[int],
      features_extractor: nn.Module,
      features_dim: int,
      activation_fn: type[nn.Module] = nn.ReLU,
      use_sde: bool = False,
      log_std_init: float = -3,
      full_std: bool = True,
      use_expln: bool = False,
      clip_mean: float = 2.0,
      normalize_images: bool = True,
  ): ...
  def _get_constructor_parameters(self) -> dict[str, Any]: ...
  def get_std(self) -> th.Tensor: ...
  def reset_noise(self, batch_size: int = 1) -> None: ...
  def get_action_dist_params(self, obs: PyTorchObs) -> tuple[th.Tensor, th.Tensor, dict[str, th.Tensor]]: ...
  def forward(self, obs: PyTorchObs, deterministic: bool = False) -> th.Tensor: ...
  def action_log_prob(self, obs: PyTorchObs) -> tuple[th.Tensor, th.Tensor]: ...
  def _predict(self, observation: PyTorchObs, deterministic: bool = False) -> th.Tensor: ...
```

**Key Parameters**:
  - `observation_space`: Observation space
  - `action_space`: Action space
  - `net_arch`: Network architecture
  - `use_sde`: Whether to use State Dependent Exploration
  - `log_std_init`: Initial value for log standard deviation

**Methods**:

- `__init__(observation_space, action_space, net_arch, features_extractor, features_dim, activation_fn, use_sde, log_std_init, full_std, use_expln, clip_mean, normalize_images)`:
  - **Function**: Initialize actor network
  - **Parameters**:
    - `observation_space`: Observation space
    - `action_space`: Action space
    - `net_arch`: Network architecture
    - `features_extractor`: Network to extract features
    - `features_dim`: Number of features
    - `activation_fn`: Activation function
    - `use_sde`: Whether to use State Dependent Exploration
    - `log_std_init`: Initial value for log standard deviation
    - `full_std`: Use full std parameters for gSDE
    - `use_expln`: Use expln function for gSDE
    - `clip_mean`: Clip mean output for gSDE
    - `normalize_images`: Whether to normalize images
  - **Details**:
    - Creates latent policy network using MLP
    - Sets up action distribution based on use_sde flag
    - Caps log standard deviation between LOG_STD_MIN and LOG_STD_MAX

- `_get_constructor_parameters()`:
  - **Function**: Get parameters for object recreation
  - **Return Value**: Dictionary of constructor parameters

- `get_std()`:
  - **Function**: Retrieve standard deviation of action distribution (gSDE only)
  - **Return Value**: Standard deviation tensor

- `reset_noise(batch_size=1)`:
  - **Function**: Sample new weights for exploration matrix (gSDE only)
  - **Parameters**:
    - `batch_size`: Batch size for noise sampling

- `get_action_dist_params(obs)`:
  - **Function**: Get parameters for action distribution
  - **Parameters**:
    - `obs`: Observation input
  - **Return Value**: Tuple of (mean_actions, log_std, kwargs)

- `forward(obs, deterministic=False)`:
  - **Function**: Forward pass through actor network
  - **Parameters**:
    - `obs`: Observation input
    - `deterministic`: Whether to use deterministic actions
  - **Return Value**: Action tensor

- `action_log_prob(obs)`:
  - **Function**: Get action and associated log probability
  - **Parameters**:
    - `obs`: Observation input
  - **Return Value**: Tuple of (action, log_prob)

- `_predict(observation, deterministic=False)`:
  - **Function**: Predict action for given observation
  - **Parameters**:
    - `observation`: Observation input
    - `deterministic`: Whether to use deterministic actions
  - **Return Value**: Action tensor

#### 185. `SACPolicy` class - Policy class for SAC
**Function**: Policy class (with both actor and critic) for SAC
**Class Definition**:
```python
class SACPolicy(BasePolicy):
    actor: Actor
    critic: ContinuousCritic
    critic_target: ContinuousCritic

    def __init__(
        self,
        observation_space: spaces.Space,
        action_space: spaces.Box,
        lr_schedule: Schedule,
        net_arch: Optional[Union[list[int], dict[str, list[int]]]] = None,
        activation_fn: type[nn.Module] = nn.ReLU,
        use_sde: bool = False,
        log_std_init: float = -3,
        use_expln: bool = False,
        clip_mean: float = 2.0,
        features_extractor_class: type[BaseFeaturesExtractor] = FlattenExtractor,
        features_extractor_kwargs: Optional[dict[str, Any]] = None,
        normalize_images: bool = True,
        optimizer_class: type[th.optim.Optimizer] = th.optim.Adam,
        optimizer_kwargs: Optional[dict[str, Any]] = None,
        n_critics: int = 2,
        share_features_extractor: bool = False,
    ): ...
    def _build(self, lr_schedule: Schedule) -> None: ...
    def _get_constructor_parameters(self) -> dict[str, Any]: ...
    def reset_noise(self, batch_size: int = 1) -> None: ...
    def make_actor(self, features_extractor: Optional[BaseFeaturesExtractor] = None) -> Actor: ...
    def make_critic(self, features_extractor: Optional[BaseFeaturesExtractor] = None) -> ContinuousCritic: ...
    def forward(self, obs: PyTorchObs, deterministic: bool = False) -> th.Tensor: ...
    def _predict(self, observation: PyTorchObs, deterministic: bool = False) -> th.Tensor: ...
    def set_training_mode(self, mode: bool) -> None: ...
```

**Key Parameters**:
  - `observation_space`: Observation space
  - `action_space`: Action space
  - `lr_schedule`: Learning rate schedule
  - `net_arch`: Policy and value network specification
  - `use_sde`: Whether to use State Dependent Exploration
  - `n_critics`: Number of critic networks

**Methods**:

- `__init__(observation_space, action_space, lr_schedule, net_arch, activation_fn, use_sde, log_std_init, use_expln, clip_mean, features_extractor_class, features_extractor_kwargs, normalize_images, optimizer_class, optimizer_kwargs, n_critics, share_features_extractor)`:
  - **Function**: Initialize SAC policy
  - **Parameters**:
    - `observation_space`: Observation space
    - `action_space`: Action space
    - `lr_schedule`: Learning rate schedule
    - `net_arch`: Network architecture specification
    - `activation_fn`: Activation function
    - `use_sde`: Whether to use State Dependent Exploration
    - `log_std_init`: Initial log standard deviation value
    - `use_expln`: Use expln function for gSDE
    - `clip_mean`: Clip mean output for gSDE
    - `features_extractor_class`: Features extractor class
    - `features_extractor_kwargs`: Features extractor keyword arguments
    - `normalize_images`: Whether to normalize images
    - `optimizer_class`: Optimizer class
    - `optimizer_kwargs`: Optimizer keyword arguments
    - `n_critics`: Number of critic networks
    - `share_features_extractor`: Share features extractor between actor and critic
  - **Details**:
    - Separates actor and critic architectures
    - Sets up SDE parameters for actor

- `_build(lr_schedule)`:
  - **Function**: Build actor and critic networks
  - **Parameters**:
    - `lr_schedule`: Learning rate schedule
  - **Details**:
    - Creates actor with optimizer
    - Creates critic with optional shared features extractor
    - Creates critic target network

- `_get_constructor_parameters()`:
  - **Function**: Get parameters for object recreation
  - **Return Value**: Dictionary of constructor parameters

- `reset_noise(batch_size=1)`:
  - **Function**: Sample new exploration weights (gSDE only)
  - **Parameters**:
    - `batch_size`: Batch size for noise sampling

- `make_actor(features_extractor=None)`:
  - **Function**: Create actor network
  - **Parameters**:
    - `features_extractor`: Optional features extractor
  - **Return Value**: Actor instance

- `make_critic(features_extractor=None)`:
  - **Function**: Create critic network
  - **Parameters**:
    - `features_extractor`: Optional features extractor
  - **Return Value**: ContinuousCritic instance

- `forward(obs, deterministic=False)`:
  - **Function**: Forward pass through policy
  - **Parameters**:
    - `obs`: Observation input
    - `deterministic`: Whether to use deterministic actions
  - **Return Value**: Action tensor

- `_predict(observation, deterministic=False)`:
  - **Function**: Predict action for observation
  - **Parameters**:
    - `observation`: Observation input
    - `deterministic`: Whether to use deterministic actions
  - **Return Value**: Action tensor

- `set_training_mode(mode)`:
  - **Function**: Set training mode for policy components
  - **Parameters**:
    - `mode`: Training mode flag

#### 186. `MlpPolicy` constant - MLP policy alias
**Description**: Alias for SACPolicy with MLP features extractor
**Value**: SACPolicy

#### 187. `CnnPolicy` class - CNN policy for SAC
**Function**: Policy class with CNN features extractor for SAC
**Class Definition**:
```python
class CnnPolicy(SACPolicy):
    def __init__(
        self,
        observation_space: spaces.Space,
        action_space: spaces.Box,
        lr_schedule: Schedule,
        net_arch: Optional[Union[list[int], dict[str, list[int]]]] = None,
        activation_fn: type[nn.Module] = nn.ReLU,
        use_sde: bool = False,
        log_std_init: float = -3,
        use_expln: bool = False,
        clip_mean: float = 2.0,
        features_extractor_class: type[BaseFeaturesExtractor] = NatureCNN,
        features_extractor_kwargs: Optional[dict[str, Any]] = None,
        normalize_images: bool = True,
        optimizer_class: type[th.optim.Optimizer] = th.optim.Adam,
        optimizer_kwargs: Optional[dict[str, Any]] = None,
        n_critics: int = 2,
        share_features_extractor: bool = False,
    )
```
**Details**: Inherits from SACPolicy with NatureCNN as default features extractor

#### 188. `MultiInputPolicy` class - Multi-input policy for SAC
**Function**: Policy class with combined features extractor for SAC
**Class Definition**:
```python
class MultiInputPolicy(SACPolicy):
    def __init__(
        self,
        observation_space: spaces.Space,
        action_space: spaces.Box,
        lr_schedule: Schedule,
        net_arch: Optional[Union[list[int], dict[str, list[int]]]] = None,
        activation_fn: type[nn.Module] = nn.ReLU,
        use_sde: bool = False,
        log_std_init: float = -3,
        use_expln: bool = False,
        clip_mean: float = 2.0,
        features_extractor_class: type[BaseFeaturesExtractor] = CombinedExtractor,
        features_extractor_kwargs: Optional[dict[str, Any]] = None,
        normalize_images: bool = True,
        optimizer_class: type[th.optim.Optimizer] = th.optim.Adam,
        optimizer_kwargs: Optional[dict[str, Any]] = None,
        n_critics: int = 2,
        share_features_extractor: bool = False,
    )
```
**Details**: Inherits from SACPolicy with CombinedExtractor as default features extractor

#### 189. `GoalSelectionStrategy` Enum - HER Goal Selection Strategies

**Description**: Enumeration of strategies for selecting new goals when creating artificial transitions in Hindsight Experience Replay.
```python
class GoalSelectionStrategy(Enum):
    """
    The strategies for selecting new goals when
    creating artificial transitions.
    """

    # Select a goal that was achieved
    # after the current step, in the same episode
    FUTURE = 0
    # Select the goal that was achieved
    # at the end of the episode
    FINAL = 1
    # Select a goal that was achieved in the episode
    EPISODE = 2
```

#### 190. `KEY_TO_GOAL_STRATEGY` Constant - Strategy Name Mapping

**Description**: Dictionary mapping string keys to GoalSelectionStrategy enum values for convenient configuration.

**Structure**:
```python
KEY_TO_GOAL_STRATEGY = {
    "future": GoalSelectionStrategy.FUTURE,
    "final": GoalSelectionStrategy.FINAL,
    "episode": GoalSelectionStrategy.EPISODE,
}
```
#### 191. `BitFlippingEnv` class - Bit flipping environment for HER testing
**Function**: Simple bit flipping environment useful to test HER (Hindsight Experience Replay)
**Class Definition**:
```python
class BitFlippingEnv(Env):
    spec = EnvSpec("BitFlippingEnv-v0", "no-entry-point")
    state: np.ndarray

    def __init__(
        self,
        n_bits: int = 10,
        continuous: bool = False,
        max_steps: Optional[int] = None,
        discrete_obs_space: bool = False,
        image_obs_space: bool = False,
        channel_first: bool = True,
        render_mode: str = "human",
    ): ...
    def seed(self, seed: int) -> None: ...
    def convert_if_needed(self, state: np.ndarray) -> Union[int, np.ndarray]: ...
    def convert_to_bit_vector(self, state: Union[int, np.ndarray], batch_size: int) -> np.ndarray: ...
    def _make_observation_space(self, discrete_obs_space: bool, image_obs_space: bool, n_bits: int) -> spaces.Dict: ...
    def _get_obs(self) -> dict[str, Union[int, np.ndarray]]: ...
    def reset(self, *, seed: Optional[int] = None, options: Optional[dict] = None) -> tuple[dict[str, Union[int, np.ndarray]], dict]: ...
    def step(self, action: Union[np.ndarray, int]) -> GymStepReturn: ...
    def compute_reward(
        self, achieved_goal: Union[int, np.ndarray], desired_goal: Union[int, np.ndarray], _info: Optional[dict[str, Any]]
    ) -> np.float32: ...
    def render(self) -> Optional[np.ndarray]: ...
    def close(self) -> None: ...
```

**Key Parameters**:
  - `n_bits`: Number of bits to flip
  - `continuous`: Whether to use continuous actions version
  - `max_steps`: Max number of steps
  - `discrete_obs_space`: Whether to use discrete observation version
  - `image_obs_space`: Whether to use image observation version
  - `channel_first`: Whether to use channel-first image format

**Methods**:

- `__init__(n_bits=10, continuous=False, max_steps=None, discrete_obs_space=False, image_obs_space=False, channel_first=True, render_mode="human")`:
  - **Function**: Initialize bit flipping environment
  - **Parameters**:
    - `n_bits`: Number of bits to flip
    - `continuous`: Use continuous actions version
    - `max_steps`: Max number of steps (defaults to n_bits)
    - `discrete_obs_space`: Use discrete observation space
    - `image_obs_space`: Use image observation space
    - `channel_first`: Use channel-first image format
    - `render_mode`: Rendering mode
  - **Details**:
    - Creates observation space based on configuration
    - Sets up action space (continuous Box or discrete Discrete)
    - Initializes desired goal as vector of ones

- `seed(seed)`:
  - **Function**: Seed the environment
  - **Parameters**:
    - `seed`: Random seed
  - **Return Value**: None

- `convert_if_needed(state)`:
  - **Function**: Convert state to discrete space if needed
  - **Parameters**:
    - `state`: State to convert
  - **Return Value**: Converted state (int for discrete, array otherwise)

- `convert_to_bit_vector(state, batch_size)`:
  - **Function**: Convert state to bit vector if needed
  - **Parameters**:
    - `state`: State to convert (int or array)
    - `batch_size`: Batch size for conversion
  - **Return Value**: Bit vector representation

- `_make_observation_space(discrete_obs_space, image_obs_space, n_bits)`:
  - **Function**: Create observation space based on configuration
  - **Parameters**:
    - `discrete_obs_space`: Use discrete observation space
    - `image_obs_space`: Use image observation space
    - `n_bits`: Number of bits
  - **Return Value**: Observation space dictionary
  - **Details**:
    - Creates different observation spaces for discrete, image, and binary cases

- `_get_obs()`:
  - **Function**: Create the current observation
  - **Return Value**: Dictionary with observation, achieved_goal, and desired_goal

- `reset(seed=None, options=None)`:
  - **Function**: Reset the environment
  - **Parameters**:
    - `seed`: Random seed
    - `options`: Reset options
  - **Return Value**: Tuple of (observation, info)

- `step(action)`:
  - **Function**: Execute environment step
  - **Parameters**:
    - `action`: Action to take (array for continuous, int for discrete)
  - **Return Value**: Tuple of (observation, reward, terminated, truncated, info)
  - **Details**:
    - Flips bits based on action
    - Computes reward using compute_reward method
    - Terminates when goal is achieved or max steps reached

- `compute_reward(achieved_goal, desired_goal, _info)`:
  - **Function**: Compute reward based on achieved and desired goals
  - **Parameters**:
    - `achieved_goal`: Achieved goal state
    - `desired_goal`: Desired goal state
    - `_info`: Additional info (unused)
  - **Return Value**: Reward value
  - **Details**:
    - Uses deceptive reward: positive only when goal is achieved
    - Handles different observation space types

- `render()`:
  - **Function**: Render the environment
  - **Return Value**: State array if rgb_array mode, None otherwise

- `close()`:
  - **Function**: Close the environment
  - **Return Value**: None

#### 192. `IdentityEnv` class - Identity environment for testing
**Function**: Identity environment for testing purposes with generic state type
**Class Definition**:
```python
class IdentityEnv(gym.Env, Generic[T]):
    def __init__(self, dim: Optional[int] = None, space: Optional[spaces.Space] = None, ep_length: int = 100): ...
    def reset(self, *, seed: Optional[int] = None, options: Optional[dict] = None) -> tuple[T, dict]: ...
    def step(self, action: T) -> tuple[T, float, bool, bool, dict[str, Any]]: ...
    def _choose_next_state(self) -> None: ...
    def _get_reward(self, action: T) -> float: ...
    def render(self, mode: str = "human") -> None: ...
```

**Key Parameters**:
  - `dim`: Size of action and observation dimension
  - `space`: Action and observation space
  - `ep_length`: Length of each episode in timesteps

**Methods**:

- `__init__(dim=None, space=None, ep_length=100)`:
  - **Function**: Initialize identity environment
  - **Parameters**:
    - `dim`: Size of action/observation dimension
    - `space`: Action and observation space
    - `ep_length`: Episode length in timesteps
  - **Details**:
    - Creates identical action and observation spaces
    - Initializes step counter and reset counter

- `reset(seed=None, options=None)`:
  - **Function**: Reset the environment
  - **Parameters**:
    - `seed`: Random seed
    - `options`: Reset options
  - **Return Value**: Tuple of (state, info)

- `step(action)`:
  - **Function**: Execute environment step
  - **Parameters**:
    - `action`: Action to take
  - **Return Value**: Tuple of (state, reward, terminated, truncated, info)
  - **Details**:
    - Gives reward 1.0 if action matches state, 0.0 otherwise
    - Never terminates, truncates after ep_length steps

- `_choose_next_state()`:
  - **Function**: Sample new state from action space
  - **Return Value**: None

- `_get_reward(action)`:
  - **Function**: Compute reward based on action
  - **Parameters**:
    - `action`: Action taken
  - **Return Value**: 1.0 if action matches state, 0.0 otherwise

- `render(mode="human")`:
  - **Function**: Render environment (no-op)
  - **Return Value**: None

#### 193. `IdentityEnvBox` class - Box identity environment
**Function**: Identity environment with Box action/observation space
**Class Definition**:
```python
class IdentityEnvBox(IdentityEnv[np.ndarray]):
    def __init__(self, low: float = -1.0, high: float = 1.0, eps: float = 0.05, ep_length: int = 100): ...
    def step(self, action: np.ndarray) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]: ...
    def _get_reward(self, action: np.ndarray) -> float: ...
```

**Key Parameters**:
  - `low`: Lower bound of box dimension
  - `high`: Upper bound of box dimension
  - `eps`: Epsilon bound for correct value
  - `ep_length`: Episode length

**Methods**:

- `__init__(low=-1.0, high=1.0, eps=0.05, ep_length=100)`:
  - **Function**: Initialize box identity environment
  - **Parameters**:
    - `low`: Lower bound of box
    - `high`: Upper bound of box
    - `eps`: Epsilon tolerance for reward
    - `ep_length`: Episode length
  - **Details**:
    - Creates Box space with shape (1,)

- `step(action)`:
  - **Function**: Execute environment step
  - **Parameters**:
    - `action`: Action array
  - **Return Value**: Tuple of (state, reward, terminated, truncated, info)

- `_get_reward(action)`:
  - **Function**: Compute reward with epsilon tolerance
  - **Parameters**:
    - `action`: Action array
  - **Return Value**: 1.0 if action within eps of state, 0.0 otherwise

#### 194. `IdentityEnvMultiDiscrete` class - MultiDiscrete identity environment
**Function**: Identity environment with MultiDiscrete action/observation space
**Class Definition**:
```python
class IdentityEnvMultiDiscrete(IdentityEnv[np.ndarray]):
  def __init__(self, dim: int = 1, ep_length: int = 100) -> None:
    """
    Identity environment for testing purposes

    :param dim: the size of the dimensions you want to learn
    :param ep_length: the length of each episode in timesteps
    """
    space = spaces.MultiDiscrete([dim, dim])
    super().__init__(ep_length=ep_length, space=space)
```

**Key Parameters**:
  - `dim`: Size of dimensions
  - `ep_length`: Episode length

**Details**: Inherits from IdentityEnv with MultiDiscrete space of [dim, dim]

#### 195. `IdentityEnvMultiBinary` class - MultiBinary identity environment
**Function**: Identity environment with MultiBinary action/observation space
**Class Definition**:
```python
class IdentityEnvMultiBinary(IdentityEnv[np.ndarray]):
    def __init__(self, dim: int = 1, ep_length: int = 100) -> None:
      """
      Identity environment for testing purposes

      :param dim: the size of the dimensions you want to learn
      :param ep_length: the length of each episode in timesteps
      """
      space = spaces.MultiBinary(dim)
      super().__init__(ep_length=ep_length, space=space)
```

**Key Parameters**:
  - `dim`: Size of dimensions
  - `ep_length`: Episode length

**Details**: Inherits from IdentityEnv with MultiBinary space of size dim

#### 196. `FakeImageEnv` class - Fake image environment for testing
**Function**: Fake image environment that mimics Atari games for testing
**Class Definition**:
```python
class FakeImageEnv(gym.Env):
  """
  Fake image environment for testing purposes, it mimics Atari games.

  :param action_dim: Number of discrete actions
  :param screen_height: Height of the image
  :param screen_width: Width of the image
  :param n_channels: Number of color channels
  :param discrete: Create discrete action space instead of continuous
  :param channel_first: Put channels on first axis instead of last
  """
  def __init__(
      self,
      action_dim: int = 6,
      screen_height: int = 84,
      screen_width: int = 84,
      n_channels: int = 1,
      discrete: bool = True,
      channel_first: bool = False,
  ) -> None: ...
  def reset(self, *, seed: Optional[int] = None, options: Optional[dict] = None) -> tuple[np.ndarray, dict]: ...
  def step(self, action: Union[np.ndarray, int]) -> GymStepReturn: ...
  def render(self, mode: str = "human") -> None: ...
```

**Key Parameters**:
  - `action_dim`: Number of discrete actions
  - `screen_height`: Height of the image
  - `screen_width`: Width of the image
  - `n_channels`: Number of color channels
  - `discrete`: Create discrete action space
  - `channel_first`: Put channels on first axis

**Methods**:

- `__init__(action_dim=6, screen_height=84, screen_width=84, n_channels=1, discrete=True, channel_first=False)`:
  - **Function**: Initialize fake image environment
  - **Parameters**:
    - `action_dim`: Number of discrete actions
    - `screen_height`: Image height
    - `screen_width`: Image width
    - `n_channels`: Number of color channels
    - `discrete`: Use discrete action space
    - `channel_first`: Channel-first image format
  - **Details**:
    - Creates Box observation space for images
    - Creates Discrete or Box action space based on discrete flag

- `reset(seed=None, options=None)`:
  - **Function**: Reset the environment
  - **Parameters**:
    - `seed`: Random seed
    - `options`: Reset options
  - **Return Value**: Tuple of (random observation, info)

- `step(action)`:
  - **Function**: Execute environment step
  - **Parameters**:
    - `action`: Action to take
  - **Return Value**: Tuple of (random observation, 0.0 reward, False terminated, truncated, info)
  - **Details**:
    - Always returns zero reward and random observation
    - Truncates after 10 steps

- `render(mode="human")`:
  - **Function**: Render environment (no-op)
  - **Return Value**: None

#### 197. `SimpleMultiObsEnv` class - GridWorld-based MultiObs Environment
**Function**: Base class for GridWorld-based MultiObs Environments with 4x4 grid world
**Class Definition**:
```python
class SimpleMultiObsEnv(gym.Env):
    def __init__(
        self,
        num_col: int = 4,
        num_row: int = 4,
        random_start: bool = True,
        discrete_actions: bool = True,
        channel_last: bool = True,
    ): ...
    def init_state_mapping(self, num_col: int, num_row: int) -> None: ...
    def get_state_mapping(self) -> dict[str, np.ndarray]: ...
    def init_possible_transitions(self) -> None: ...
    def step(self, action: Union[int, np.ndarray]) -> GymStepReturn: ...
    def render(self, mode: str = "human") -> None: ...
    def reset(self, *, seed: Optional[int] = None, options: Optional[dict] = None) -> tuple[dict[str, np.ndarray], dict]: ...
```

**Key Parameters**:
  - `num_col`: Number of columns in the grid
  - `num_row`: Number of rows in the grid
  - `random_start`: If true, agent starts in random position
  - `discrete_actions`: If true, use discrete action space
  - `channel_last`: If true, image will be channel last

**Methods**:

- `__init__(num_col=4, num_row=4, random_start=True, discrete_actions=True, channel_last=True)`:
  - **Function**: Initialize multi-observation grid environment
  - **Parameters**:
    - `num_col`: Number of columns
    - `num_row`: Number of rows
    - `random_start`: Start in random position
    - `discrete_actions`: Use discrete action space
    - `channel_last`: Use channel-last image format
  - **Details**:
    - Creates Dict observation space with vector and image components
    - Sets up Discrete or Box action space
    - Initializes state mapping and transitions
    - Sets up 4x4 grid world with blocked states

- `init_state_mapping(num_col, num_row)`:
  - **Function**: Initialize state_mapping array with observation values
  - **Parameters**:
    - `num_col`: Number of columns
    - `num_row`: Number of rows
  - **Details**:
    - Creates random vectors for columns
    - Creates random images for rows
    - Maps each grid cell to vector and image observations

- `get_state_mapping()`:
  - **Function**: Get observation mapping for current state
  - **Return Value**: Observation dict with 'vec' and 'img' keys

- `init_possible_transitions()`:
  - **Function**: Initialize environment transitions
  - **Details**:
    - Defines possible movements for each direction
    - Uses grid coordinates to determine valid transitions

- `step(action)`:
  - **Function**: Execute environment step
  - **Parameters**:
    - `action`: Action to take (int for discrete, array for continuous)
  - **Return Value**: Tuple of (observation, reward, terminated, truncated, info)
  - **Details**:
    - Converts continuous action to discrete if needed
    - Applies movement based on action and current state
    - Gives reward 1.0 for reaching goal, -0.1 otherwise
    - Terminates when reaching goal, truncates after max steps

- `render(mode="human")`:
  - **Function**: Render environment by printing log
  - **Parameters**:
    - `mode`: Rendering mode
  - **Return Value**: None

- `reset(seed=None, options=None)`:
  - **Function**: Reset environment state and step count
  - **Parameters**:
    - `seed`: Random seed
    - `options`: Reset options
  - **Return Value**: Tuple of (observation, info)
  - **Details**:
    - Resets to start state or random state based on random_start

#### 198. `RMSpropTFLike` Class - TensorFlow-like RMSprop Optimizer

**Function**: RMSprop optimizer implementation that closely matches TensorFlow's behavior for compatibility with original Stable Baselines.

**Class Definition**:

```python
class RMSpropTFLike(Optimizer):
    def __init__(
        self,
        params: Iterable[torch.nn.Parameter],
        lr: float = 1e-2,
        alpha: float = 0.99,
        eps: float = 1e-8,
        weight_decay: float = 0,
        momentum: float = 0,
        centered: bool = False,
    ):
        ...

    def __setstate__(self, state: dict[str, Any]) -> None:
        ...
    @torch.no_grad()
    def step(self, closure: Optional[Callable[[], float]] = None) -> Optional[float]:
        ...
```

**Key Parameters**:
- `lr`: Learning rate (1e-2 default)
- `alpha`: Smoothing constant (0.99 default)
- `eps`: Denominator stability term (1e-8 default)
- `weight_decay`: L2 penalty coefficient (0 default)
- `momentum`: Momentum factor (0 default)
- `centered`: Use centered RMSprop (False default)

**Core Methods**:

- `step(closure)`:
  - **Function**: Perform a single optimization step.
  - **Parameters**: `closure`: Optional closure that recomputes loss
  - **Return Value**: Loss value if closure provided
  - **Details**: Updates parameters using RMSprop algorithm with TensorFlow-specific modifications.

**Key Differences from PyTorch RMSprop**:
- Moves epsilon inside square root operation
- Initializes squared gradient to ones instead of zeros
- Maintains compatibility with original Stable Baselines implementations
- Provides more stable learning behavior for certain algorithms like A2C

**Algorithm Details**:
- Uses moving average of squared gradients for adaptive learning rates
- Supports momentum for accelerated convergence
- Optional centering for gradient normalization
- L2 weight decay regularization
- Designed for reproducibility with TensorFlow-based implementations

#### 199. `VecEnvIndices` constant - VecEnv indices type alias
**Description**: Type alias for VecEnv indices
**Value**: Union[None, int, Iterable[int]]

#### 200. `VecEnvObs` constant - VecEnv observation type alias
**Description**: Type alias for VecEnv observations
**Value**: Union[np.ndarray, dict[str, np.ndarray], tuple[np.ndarray, ...]]

#### 201. `VecEnvStepReturn` constant - VecEnv step return type alias
**Description**: Type alias for VecEnv step returns
**Value**: tuple[VecEnvObs, np.ndarray, np.ndarray, list[dict]]

#### 202. `tile_images` function - Tile multiple images into one
**Function**: Tile N images into one big PxQ image
**Function Signature**:
```python
def tile_images(images_nhwc: Sequence[np.ndarray]) -> np.ndarray:
  """
  Tile N images into one big PxQ image
  (P,Q) are chosen to be as close as possible, and if N
  is square, then P=Q.

  :param images_nhwc: list or array of images, ndim=4 once turned into array.
      n = batch index, h = height, w = width, c = channel
  :return: img_HWc, ndim=3
  """
```
**Parameter Description**:
  - `images_nhwc`: list or array of images (n=batch, h=height, w=width, c=channel)
**Return Value**: Tiled image as ndarray

#### 203. `VecEnv` class - Abstract asynchronous vectorized environment
**Function**: An abstract asynchronous, vectorized environment
**Class Definition**:
```python
class VecEnv(ABC):
  """
  An abstract asynchronous, vectorized environment.

  :param num_envs: Number of environments
  :param observation_space: Observation space
  :param action_space: Action space
  """
  def __init__(
      self,
      num_envs: int,
      observation_space: spaces.Space,
      action_space: spaces.Space,
  ): ...
  def _reset_seeds(self) -> None: ...
  def _reset_options(self) -> None: ...
  @abstractmethod
  def reset(self) -> VecEnvObs: ...
  @abstractmethod
  def step_async(self, actions: np.ndarray) -> None: ...
  @abstractmethod
  def step_wait(self) -> VecEnvStepReturn: ...
  @abstractmethod
  def close(self) -> None: ...
  def has_attr(self, attr_name: str) -> bool: ...
  @abstractmethod
  def get_attr(self, attr_name: str, indices: VecEnvIndices = None) -> list[Any]: ...
   @abstractmethod
  def set_attr(self, attr_name: str, value: Any, indices: VecEnvIndices = None) -> None: ...
  @abstractmethod
  def env_method(self, method_name: str, *method_args, indices: VecEnvIndices = None, **method_kwargs) -> list[Any]: ...
  @abstractmethod
  def env_is_wrapped(self, wrapper_class: type[gym.Wrapper], indices: VecEnvIndices = None) -> list[bool]: ...
  def step(self, actions: np.ndarray) -> VecEnvStepReturn: ...
  def get_images(self) -> Sequence[Optional[np.ndarray]]: ...
  def render(self, mode: Optional[str] = None) -> Optional[np.ndarray]: ...
  def seed(self, seed: Optional[int] = None) -> Sequence[Union[None, int]]: ...
  def set_options(self, options: Optional[Union[list[dict], dict]] = None) -> None: ...
  @property
  def unwrapped(self) -> "VecEnv": ...
  def getattr_depth_check(self, name: str, already_found: bool) -> Optional[str]: ...
  def _get_indices(self, indices: VecEnvIndices) -> Iterable[int]: ...
```

**Key Parameters**:
  - `num_envs`: Number of environments
  - `observation_space`: Observation space
  - `action_space`: Action space

**Methods**:

- `__init__(num_envs, observation_space, action_space)`:
  - **Function**: Initialize vectorized environment
  - **Parameters**:
    - `num_envs`: Number of environments
    - `observation_space`: Observation space
    - `action_space`: Action space
  - **Details**:
    - Sets up seeds and options for reset
    - Checks render mode consistency across environments

- `_reset_seeds()`:
  - **Function**: Reset seeds for next reset
  - **Return Value**: None

- `_reset_options()`:
  - **Function**: Reset options for next reset
  - **Return Value**: None

- `reset()`:
  - **Function**: Reset all environments (abstract)
  - **Return Value**: Array of observations

- `step_async(actions)`:
  - **Function**: Tell environments to start taking step (abstract)
  - **Parameters**:
    - `actions`: Actions to take

- `step_wait()`:
  - **Function**: Wait for step results (abstract)
  - **Return Value**: observation, reward, done, information

- `close()`:
  - **Function**: Clean up resources (abstract)
  - **Return Value**: None

- `has_attr(attr_name)`:
  - **Function**: Check if attribute exists
  - **Parameters**:
    - `attr_name`: Attribute name to check
  - **Return Value**: True if attribute exists in all environments

- `get_attr(attr_name, indices=None)`:
  - **Function**: Return attribute from environments (abstract)
  - **Parameters**:
    - `attr_name`: Attribute name
    - `indices`: Environment indices
  - **Return Value**: List of attribute values

- `set_attr(attr_name, value, indices=None)`:
  - **Function**: Set attribute in environments (abstract)
  - **Parameters**:
    - `attr_name`: Attribute name
    - `value`: Value to set
    - `indices`: Environment indices

- `env_method(method_name, *method_args, indices=None, **method_kwargs)`:
  - **Function**: Call environment methods (abstract)
  - **Parameters**:
    - `method_name`: Method name to call
    - `indices`: Environment indices
    - `method_args`: Positional arguments
    - `method_kwargs`: Keyword arguments
  - **Return Value**: List of method return values

- `env_is_wrapped(wrapper_class, indices=None)`:
  - **Function**: Check if environments are wrapped (abstract)
  - **Parameters**:
    - `wrapper_class`: Wrapper class to check
    - `indices`: Environment indices
  - **Return Value**: List of boolean results

- `step(actions)`:
  - **Function**: Step environments with given action
  - **Parameters**:
    - `actions`: Actions to take
  - **Return Value**: observation, reward, done, information

- `get_images()`:
  - **Function**: Return RGB images when available
  - **Return Value**: Sequence of images

- `render(mode=None)`:
  - **Function**: Render environments
  - **Parameters**:
    - `mode`: Rendering mode
  - **Return Value**: Rendered image or None

- `seed(seed=None)`:
  - **Function**: Set random seeds for environments
  - **Parameters**:
    - `seed`: Random seed
  - **Return Value**: List of seeds

- `set_options(options=None)`:
  - **Function**: Set environment options
  - **Parameters**:
    - `options`: Environment options
  - **Return Value**: None
- `unwrapped`:
  - **Function**: Get unwrapped environment
  - **Return Value**: Unwrapped environment

- `getattr_depth_check(name, already_found)`:
  - **Function**: Check for recursive attribute lookup
  - **Parameters**:
    - `name`: Attribute name
    - `already_found`: Whether attribute already found
  - **Return Value**: Module name if shadowed

- `_get_indices(indices)`:
  - **Function**: Convert indices to list
  - **Parameters**:
    - `indices`: Environment indices
  - **Return Value**: List of indices

#### 204. `VecEnvWrapper` class - Vectorized environment wrapper
**Function**: Vectorized environment base wrapper class
**Class Definition**:
```python
class VecEnvWrapper(VecEnv):
  """
  Vectorized environment base class

  :param venv: the vectorized environment to wrap
  :param observation_space: the observation space (can be None to load from venv)
  :param action_space: the action space (can be None to load from venv)
  """
  def __init__(
      self,
      venv: VecEnv,
      observation_space: Optional[spaces.Space] = None,
      action_space: Optional[spaces.Space] = None,
  ): ...
  def step_async(self, actions: np.ndarray) -> None: ...
  @abstractmethod
  def reset(self) -> VecEnvObs: ...
  @abstractmethod
  def step_wait(self) -> VecEnvStepReturn: ...
  def seed(self, seed: Optional[int] = None) -> Sequence[Union[None, int]]: ...
  def set_options(self, options: Optional[Union[list[dict], dict]] = None) -> None: ...
  def close(self) -> None: ...
  def render(self, mode: Optional[str] = None) -> Optional[np.ndarray]: ...
  def get_images(self) -> Sequence[Optional[np.ndarray]]: ...
  def has_attr(self, attr_name: str) -> bool: ...
  def get_attr(self, attr_name: str, indices: VecEnvIndices = None) -> list[Any]: ...
  def set_attr(self, attr_name: str, value: Any, indices: VecEnvIndices = None) -> None: ...
  def env_method(self, method_name: str, *method_args, indices: VecEnvIndices = None, **method_kwargs) -> list[Any]: ...
  def env_is_wrapped(self, wrapper_class: type[gym.Wrapper], indices: VecEnvIndices = None) -> list[bool]: ...
  def __getattr__(self, name: str) -> Any: ...
  def _get_all_attributes(self) -> dict[str, Any]: ...
  def getattr_recursive(self, name: str) -> Any: ...
  def getattr_depth_check(self, name: str, already_found: bool) -> Optional[str]: ...
```

**Key Parameters**:
  - `venv`: Vectorized environment to wrap
  - `observation_space`: Override observation space
  - `action_space`: Override action space

**Details**: Wraps a VecEnv and delegates most methods to it

#### 205. `CloudpickleWrapper` class - Cloudpickle serialization wrapper
**Function**: Uses cloudpickle to serialize contents for multiprocessing
**Class Definition**:
```python
class CloudpickleWrapper:
  """
  Uses cloudpickle to serialize contents (otherwise multiprocessing tries to use pickle)

  :param var: the variable you wish to wrap for pickling with cloudpickle
  """
  def __init__(self, var: Any)
  def __getstate__(self) -> Any
  def __setstate__(self, var: Any) -> None
```

**Methods**:

- `__init__(var)`:
  - **Function**: Initialize wrapper with variable
  - **Parameters**:
    - `var`: Variable to wrap

- `__getstate__()`:
  - **Function**: Serialize variable with cloudpickle
  - **Return Value**: Pickled variable

- `__setstate__(var)`:
  - **Function**: Deserialize variable
  - **Parameters**:
    - `var`: Pickled variable
  - **Return Value**: None

#### 206. `DummyVecEnv` class - Simple vectorized environment wrapper
**Function**: Creates a simple vectorized wrapper for multiple environments, calling each environment in sequence on the current Python process
**Class Definition**:
```python
class DummyVecEnv(VecEnv):
   """
  Creates a simple vectorized wrapper for multiple environments, calling each environment in sequence on the current
  Python process. This is useful for computationally simple environment such as ``Cartpole-v1``,
  as the overhead of multiprocess or multithread outweighs the environment computation time.
  This can also be used for RL methods that
  require a vectorized environment, but that you want a single environments to train with.

  :param env_fns: a list of functions
      that return environments to vectorize
  :raises ValueError: If the same environment instance is passed as the output of two or more different env_fn.
  """
  actions: np.ndarray

  def __init__(self, env_fns: list[Callable[[], gym.Env]]): ...
  def step_async(self, actions: np.ndarray) -> None: ...
  def step_wait(self) -> VecEnvStepReturn: ...
  def reset(self) -> VecEnvObs: ...
  def close(self) -> None: ...
  def get_images(self) -> Sequence[Optional[np.ndarray]]: ...
  def render(self, mode: Optional[str] = None) -> Optional[np.ndarray]: ...
  def _save_obs(self, env_idx: int, obs: VecEnvObs) -> None: ...
  def _obs_from_buf(self) -> VecEnvObs: ...
  def get_attr(self, attr_name: str, indices: VecEnvIndices = None) -> list[Any]: ...
  def set_attr(self, attr_name: str, value: Any, indices: VecEnvIndices = None) -> None: ...
  def env_method(self, method_name: str, *method_args, indices: VecEnvIndices = None, **method_kwargs) -> list[Any]: ...
  def env_is_wrapped(self, wrapper_class: type[gym.Wrapper], indices: VecEnvIndices = None) -> list[bool]: ...
  def _get_target_envs(self, indices: VecEnvIndices) -> list[gym.Env]: ...
```

**Key Parameters**:
  - `env_fns`: List of functions that return environments to vectorize

**Methods**:

- `__init__(env_fns)`:
  - **Function**: Initialize dummy vectorized environment
  - **Parameters**:
    - `env_fns`: List of environment constructor functions
  - **Details**:
    - Creates environments and patches them
    - Checks for duplicate environment instances
    - Initializes observation buffers
    - Sets up metadata from first environment

- `step_async(actions)`:
  - **Function**: Store actions for next step
  - **Parameters**:
    - `actions`: Actions to take in each environment
  - **Return Value**: None

- `step_wait()`:
  - **Function**: Execute stored actions and return results
  - **Return Value**: Tuple of (observations, rewards, dones, infos)
  - **Details**:
    - Steps through each environment sequentially
    - Handles episode termination and reset
    - Saves final observations for terminated episodes
    - Updates observation buffers

- `reset()`:
  - **Function**: Reset all environments
  - **Return Value**: Observations from all environments
  - **Details**:
    - Resets each environment with stored seeds and options
    - Clears seeds and options after use
    - Saves observations to buffers

- `close()`:
  - **Function**: Close all environments
  - **Return Value**: None

- `get_images()`:
  - **Function**: Get rendered images from all environments
  - **Return Value**: Sequence of images or None for each environment
  - **Details**:
    - Warns if render mode is not 'rgb_array'
    - Returns None for non-rgb_array render modes

- `render(mode=None)`:
  - **Function**: Render environments using base VecEnv render method
  - **Parameters**:
    - `mode`: Rendering mode
  - **Return Value**: Tiled image or None

- `_save_obs(env_idx, obs)`:
  - **Function**: Save observation to buffer for specific environment
  - **Parameters**:
    - `env_idx`: Environment index
    - `obs`: Observation to save
  - **Return Value**: None

- `_obs_from_buf()`:
  - **Function**: Create observation from buffer
  - **Return Value**: Observation dictionary or array

- `get_attr(attr_name, indices=None)`:
  - **Function**: Get attribute from vectorized environments
  - **Parameters**:
    - `attr_name`: Attribute name
    - `indices`: Environment indices
  - **Return Value**: List of attribute values

- `set_attr(attr_name, value, indices=None)`:
  - **Function**: Set attribute in vectorized environments
  - **Parameters**:
    - `attr_name`: Attribute name
    - `value`: Value to set
    - `indices`: Environment indices
  - **Return Value**: None

- `env_method(method_name, *method_args, indices=None, **method_kwargs)`:
  - **Function**: Call instance methods of vectorized environments
  - **Parameters**:
    - `method_name`: Method name to call
    - `indices`: Environment indices
    - `method_args`: Positional arguments
    - `method_kwargs`: Keyword arguments
  - **Return Value**: List of method return values

- `env_is_wrapped(wrapper_class, indices=None)`:
  - **Function**: Check if environments are wrapped with given wrapper
  - **Parameters**:
    - `wrapper_class`: Wrapper class to check
    - `indices`: Environment indices
  - **Return Value**: List of boolean results

- `_get_target_envs(indices)`:
  - **Function**: Get target environments based on indices
  - **Parameters**:
    - `indices`: Environment indices
  - **Return Value**: List of environment instances

#### 207. `_patch_env` Function - Gym to Gymnasium Environment Converter

**Function**: Convert OpenAI Gym environments to Gymnasium format using Shimmy compatibility wrappers.

**Function Signature**:
```python
def _patch_env(env: Union["gym.Env", gymnasium.Env]) -> gymnasium.Env:
  """
  Adapted from https://github.com/thu-ml/tianshou.

  Takes an environment and patches it to return Gymnasium env.
  This function takes the environment object and returns a patched
  env, using shimmy wrapper to convert it to Gymnasium,
  if necessary.

  :param env: A gym/gymnasium env
  :return: Patched env (gymnasium env)
  """
```

**Parameter Description**: `env`: OpenAI Gym or Gymnasium environment to patch

**Return Value**: Gymnasium-compatible environment

**Details**: 
- Detects environment type and applies appropriate Shimmy wrapper
- For Gym 0.26+: Uses `GymV26CompatibilityV0` wrapper
- For Gym 0.21: Uses `GymV21CompatibilityV0` wrapper
- Issues warnings about transitioning to Gymnasium

#### 208. `_convert_space` Function - Gym to Gymnasium Space Converter

**Function**: Convert OpenAI Gym spaces to Gymnasium format.

**Function Signature**:
```python
def _convert_space(space: Union["gym.Space", gymnasium.Space]) -> gymnasium.Space:
  """
  Takes a space and patches it to return Gymnasium Space.
  This function takes the space object and returns a patched
  space, using shimmy wrapper to convert it to Gymnasium,
  if necessary.

  :param env: A gym/gymnasium Space
  :return: Patched space (gymnasium Space)
  """
```

**Parameter Description**: `space`: OpenAI Gym or Gymnasium space to convert

**Return Value**: Gymnasium-compatible space

**Details**: Uses Shimmy's internal space conversion utilities to maintain compatibility when loading models trained with OpenAI Gym.

**Dependencies**:
- Requires `shimmy>=2.0` for environment compatibility
- Requires `shimmy>=0.2.1` for space conversion
- Provides informative error messages if Shimmy is not installed

**Purpose**: Enables backward compatibility with models and environments created using OpenAI Gym while transitioning to Gymnasium as the standard interface.

#### 209. `StackedObservations` Class - Frame Stacking Wrapper

**Function**: Frame stacking wrapper for observations that maintains a history of previous frames.

**Class Definition**:

```python
class StackedObservations(Generic[TObs]):
    def __init__(
        self,
        num_envs: int,
        n_stack: int,
        observation_space: Union[spaces.Box, spaces.Dict],
        channels_order: Optional[Union[str, Mapping[str, Optional[str]]]] = None,
    ) -> None:
        ...
    @staticmethod
    def compute_stacking(
        n_stack: int, observation_space: spaces.Box, channels_order: Optional[str] = None
    ) -> tuple[bool, int, tuple[int, ...], int]:
    def reset(self, observation: TObs) -> TObs:
        ...
    def update(
        self,
        observations: TObs,
        dones: np.ndarray,
        infos: list[dict[str, Any]],
    ) -> tuple[TObs, list[dict[str, Any]]]:
        ...
```

**Key Parameters**:
- `num_envs`: Number of parallel environments
- `n_stack`: Number of frames to stack
- `observation_space`: Environment observation space
- `channels_order`: Stacking dimension ("first", "last", or automatic)

**Core Methods**:

- `reset(observation)`:
  - **Function**: Reset stack and add initial observation.
  - **Parameters**: `observation`: Initial observation after environment reset
  - **Return Value**: Stacked observation with repeated initial frame
  - **Details**: Initializes stack with zeros and places initial observation at the end.

- `update(observations, dones, infos)`:
  - **Function**: Update stack with new observations and handle episode boundaries.
  - **Parameters**:
    - `observations`: New observations from environment step
    - `dones`: Episode termination flags
    - `infos`: Additional information dictionaries
  - **Return Value**: Tuple of (stacked_observations, updated_infos)
  - **Details**: Rolls stack to add new observations, handles terminal observations when episodes end.

- `compute_stacking(n_stack, observation_space, channels_order)`:
  - **Function**: Calculate stacking parameters for Box observation spaces.
  - **Parameters**: 
    - `n_stack`: Number of frames to stack
    - `observation_space`: Box space to stack
    - `channels_order`: Channel ordering preference
  - **Return Value**: Tuple of (channels_first, stack_dimension, stacked_shape, repeat_axis)
  - **Details**: Automatically detects channel ordering for image spaces, defaults to last dimension otherwise.

**Features**:
- Supports both Box and Dict observation spaces
- Automatic channel ordering detection for image spaces
- Handles terminal observations in info dictionaries
- Efficient circular buffer implementation using np.roll
- Compatible with vectorized environments

**Stacking Behavior**:
- For image observations: stacks along channel dimension
- For vector observations: stacks along last dimension by default
- Maintains temporal consistency across episode boundaries
- Provides proper terminal observation stacking for value estimation

#### 210. _worker_worker function - Environment worker loop for subprocess
**Function**:  
A subprocess worker function that receives commands, interacts with a gym environment, and sends results back through a multiprocessing pipe.

**Function Signature**:
```python
def _worker(
    remote: mp.connection.Connection,
    parent_remote: mp.connection.Connection,
    env_fn_wrapper: CloudpickleWrapper,
) -> None:
  from stable_baselines3.common.env_util import is_wrapped

```

**Parameter Description**:
- `remote` (mp.connection.Connection): Communication pipe for receiving commands.
- `parent_remote` (mp.connection.Connection): Parent-side connection, closed in the worker.
- `env_fn_wrapper` (CloudpickleWrapper): Wrapped environment creation function.

**Return Value**:  
None

**Details**:  
Handles commands such as `"step"`, `"reset"`, `"render"`, `"close"`, `"get_spaces"`, `"env_method"`, `"get_attr"`, `"set_attr"`, `"has_attr"`, `"is_wrapped"`.  
Communicates environment states and results back to the parent process.


#### 211. SubprocVecEnv class - Vectorized multi-process environment manager
**Function**:  
Manage multiple gym environments running in separate subprocesses, enabling parallel simulation for reinforcement learning.

**Class Definition**:
```python
class SubprocVecEnv(VecEnv):
  """
  Creates a multiprocess vectorized wrapper for multiple environments, distributing each environment to its own
  process, allowing significant speed up when the environment is computationally complex.

  For performance reasons, if your environment is not IO bound, the number of environments should not exceed the
  number of logical cores on your CPU.

  .. warning::

      Only 'forkserver' and 'spawn' start methods are thread-safe,
      which is important when TensorFlow sessions or other non thread-safe
      libraries are used in the parent (see issue #217). However, compared to
      'fork' they incur a small start-up cost and have restrictions on
      global variables. With those methods, users must wrap the code in an
      ``if __name__ == "__main__":`` block.
      For more information, see the multiprocessing documentation.

  :param env_fns: Environments to run in subprocesses
  :param start_method: method used to start the subprocesses.
          Must be one of the methods returned by multiprocessing.get_all_start_methods().
          Defaults to 'forkserver' on available platforms, and 'spawn' otherwise.
  """
  def __init__(self, env_fns: list[Callable[[], gym.Env]], start_method: Optional[str] = None): ...
  def step_async(self, actions: np.ndarray) -> None: ...
  def step_wait(self) -> VecEnvStepReturn: ...
  def reset(self) -> VecEnvObs: ...
  def close(self) -> None: ...
  def get_images(self) -> Sequence[Optional[np.ndarray]]: ...
  def has_attr(self, attr_name: str) -> bool: ...
  def get_attr(self, attr_name: str, indices: VecEnvIndices = None) -> list[Any]: ...
  def set_attr(self, attr_name: str, value: Any, indices: VecEnvIndices = None) -> None: ...
  def env_method(self, method_name: str, *method_args, indices: VecEnvIndices = None, **method_kwargs) -> list[Any]: ...
  def env_is_wrapped(self, wrapper_class: type[gym.Wrapper], indices: VecEnvIndices = None) -> list[bool]: ...
  def _get_target_remotes(self, indices: VecEnvIndices) -> list[Any]: ...
```

**Key Parameters**:
- `env_fns` (list[Callable[[], gym.Env]]): List of callables creating individual environments.
- `start_method` (Optional[str]): Multiprocessing start method ("forkserver", "spawn", etc.).

**Methods**:

- `__init__(env_fns, start_method=None)`  
  - **Function**: Initialize and spawn subprocesses for each environment.  
  - **Parameters**: `env_fns`, `start_method`.  
  - **Details**: Uses multiprocessing context; sets up pipes and processes; inherits from `VecEnv`.

- `step_async(actions)`  
  - **Function**: Send asynchronous "step" commands to subprocesses.  
  - **Parameters**: `actions` (np.ndarray).  
  - **Return Value**: None.

- `step_wait()`  
  - **Function**: Wait for subprocess responses after `step_async`.  
  - **Return Value**: `VecEnvStepReturn` (stacked observations, rewards, dones, infos).  

- `reset()`  
  - **Function**: Reset all environments in parallel.  
  - **Return Value**: `VecEnvObs`.  
  - **Details**: Resets seeds and options after use.

- `close()`  
  - **Function**: Gracefully terminate all subprocesses.  
  - **Return Value**: None.  

- `get_images()`  
  - **Function**: Collect rendered images if `render_mode` is `"rgb_array"`.  
  - **Return Value**: List of np.ndarray or None.  

- `has_attr(attr_name)`  
  - **Function**: Check attribute existence in all subprocess environments.  
  - **Parameters**: `attr_name` (str).  
  - **Return Value**: bool.  

- `get_attr(attr_name, indices=None)`  
  - **Function**: Retrieve attribute values from environments.  
  - **Return Value**: list[Any].  

- `set_attr(attr_name, value, indices=None)`  
  - **Function**: Set attribute values inside environments.  
  - **Return Value**: None.  

- `env_method(method_name, *args, indices=None, **kwargs)`  
  - **Function**: Call methods of individual environments remotely.  
  - **Return Value**: list[Any].  

- `env_is_wrapped(wrapper_class, indices=None)`  
  - **Function**: Check if environments are wrapped by a given wrapper class.  
  - **Return Value**: list[bool].  

- `_get_target_remotes(indices)`  
  - **Function**: Get remote connections by index.  
  - **Return Value**: list[Any].  


#### 212. _stack_obs function - Stack vectorized environment observations
**Function**:  
Stack observations from multiple environments into a single batched structure.

**Function Signature**:
```python
def _stack_obs(obs_list: Union[list[VecEnvObs], tuple[VecEnvObs]], space: spaces.Space) -> VecEnvObs:
  """
  Stack observations (convert from a list of single env obs to a stack of obs),
  depending on the observation space.

  :param obs: observations.
              A list or tuple of observations, one per environment.
              Each environment observation may be a NumPy array, or a dict or tuple of NumPy arrays.
  :return: Concatenated observations.
          A NumPy array or a dict or tuple of stacked numpy arrays.
          Each NumPy array has the environment index as its first axis.
  """
```

**Parameter Description**:
- `obs_list` (list or tuple): Observations from multiple environments.
- `space` (spaces.Space): Gym observation space defining structure (Dict, Tuple, or array).

**Return Value**:  
Stacked observations matching the structure of `space` (dict, tuple, or np.ndarray).

**Details**:  
Handles stacking for `Dict`, `Tuple`, and standard array observation spaces; validates input type and length.


#### 213. `dict_to_obs` Function - Convert Dictionary to Observation

**Function**: Convert internal dictionary representation of observations to the appropriate type specified by the observation space.

**Function Signature**:
```python
def dict_to_obs(obs_space: spaces.Space, obs_dict: dict[Any, np.ndarray]) -> VecEnvObs:
  """
  Convert an internal representation raw_obs into the appropriate type
  specified by space.

  :param obs_space: an observation space.
  :param obs_dict: a dict of numpy arrays.
  :return: returns an observation of the same type as space.
      If space is Dict, function is identity; if space is Tuple, converts dict to Tuple;
      otherwise, space is unstructured and returns the value raw_obs[None].
  """
```

**Parameter Description**:
- `obs_space`: The observation space defining the expected format
- `obs_dict`: Dictionary containing observation arrays

**Return Value**: Observation in the format expected by the space (Dict, Tuple, or single array)

**Details**:
- For Dict spaces: Returns the dictionary unchanged
- For Tuple spaces: Converts dictionary to tuple using integer indices
- For unstructured spaces: Extracts the single value using None key

#### 214. `obs_space_info` Function - Extract Observation Space Information

**Function**: Extract structured information (keys, shapes, dtypes) from an observation space.

**Function Signature**:
```python
def obs_space_info(obs_space: spaces.Space) -> tuple[list[str], dict[Any, tuple[int, ...]], dict[Any, np.dtype]]:\
  """
  Get dict-structured information about a gym.Space.

  Dict spaces are represented directly by their dict of subspaces.
  Tuple spaces are converted into a dict with keys indexing into the tuple.
  Unstructured spaces are represented by {None: obs_space}.

  :param obs_space: an observation space
  :return: A tuple (keys, shapes, dtypes):
      keys: a list of dict keys.
      shapes: a dict mapping keys to shapes.
      dtypes: a dict mapping keys to dtypes.
  """
```

**Parameter Description**: `obs_space`: The observation space to analyze

**Return Value**: Tuple containing:
- `keys`: List of observation keys
- `shapes`: Dictionary mapping keys to observation shapes
- `dtypes`: Dictionary mapping keys to observation data types

**Details**:
- Handles Dict, Tuple, and unstructured observation spaces
- Converts Tuple spaces to dictionary representation with integer keys
- Uses None key for unstructured spaces
- Checks for nested spaces to ensure compatibility

#### 215. `VecCheckNan` Class - NaN and Inf Checking Wrapper

**Function**: Wrapper that checks for NaN and infinity values in vectorized environment inputs and outputs for debugging numerical stability issues.

**Class Definition**:

```python
class VecCheckNan(VecEnvWrapper):
  """
  NaN and inf checking wrapper for vectorized environment, will raise a warning by default,
  allowing you to know from what the NaN of inf originated from.

  :param venv: the vectorized environment to wrap
  :param raise_exception: Whether to raise a ValueError, instead of a UserWarning
  :param warn_once: Whether to only warn once.
  :param check_inf: Whether to check for +inf or -inf as well
  """
  def __init__(self, venv: VecEnv, raise_exception: bool = False, warn_once: bool = True, check_inf: bool = True) -> None:
      ...
  def step_async(self, actions: np.ndarray) -> None:
      ...
  def step_wait(self) -> VecEnvStepReturn:
      ...
  def reset(self) -> VecEnvObs:
      ...
  def check_array_value(self, name: str, value: np.ndarray) -> list[tuple[str, str]]:
      ...
  def _check_val(self, event: str, **kwargs) -> None:
      ...
```

**Key Parameters**:
- `raise_exception`: Whether to raise ValueError instead of warning (False default)
- `warn_once`: Whether to warn only once per instance (True default)
- `check_inf`: Whether to check for infinity values in addition to NaN (True default)

**Core Methods**:

- `step_async(actions)`:
  - **Function**: Check actions for numerical issues before stepping environment.
  - **Parameters**: `actions`: Actions to be sent to environment
  - **Details**: Stores actions for error reporting and checks for NaN/inf values.

- `step_wait()`:
  - **Function**: Check observations, rewards, and dones for numerical issues after step.
  - **Return Value**: Environment step results
  - **Details**: Validates all outputs from environment step operation.

- `reset()`:
  - **Function**: Check initial observations for numerical issues after reset.
  - **Return Value**: Initial observations
  - **Details**: Validates observations returned by environment reset.

- `check_array_value(name, value)`:
  - **Function**: Check single numpy array for NaN and infinity values.
  - **Parameters**:
    - `name`: Name identifier for the value
    - `value`: Numpy array to check
  - **Return Value**: List of issues found as (name, issue_type) tuples
  - **Details**: Uses np.isnan and np.isinf for detection.

- `_check_val(event, **kwargs)`:
  - **Function**: Main validation method that checks all provided values.
  - **Parameters**:
    - `event`: Operation context ("reset", "step_async", "step_wait")
    - `**kwargs`: Values to check (observations, actions, rewards, etc.)
  - **Details**: Handles different data structures (arrays, dicts, tuples) and provides detailed error messages.

**Features**:
- Comprehensive numerical stability checking
- Support for complex observation structures (dicts, tuples)
- Configurable error handling (warnings vs exceptions)
- Detailed error messages with context about origin
- Optional infinity value checking
- One-time warning mode to reduce noise

**Use Cases**:
- Debugging training instability issues
- Identifying numerical problems in custom environments
- Validating environment implementations
- Catching gradient explosion issues early


#### 216. `VecExtractDictObs` Class - Dictionary Observation Extractor

**Function**: Vectorized environment wrapper that extracts a specific key from dictionary observations.

**Class Definition**:

```python
class VecExtractDictObs(VecEnvWrapper):
  """
  A vectorized wrapper for extracting dictionary observations.

  :param venv: The vectorized environment
  :param key: The key of the dictionary observation
  """

  def __init__(self, venv: VecEnv, key: str):
      ...
  def reset(self) -> np.ndarray:
      ...
  def step_wait(self) -> VecEnvStepReturn:
      ...
```

**Key Parameters**:
- `venv`: The vectorized environment to wrap
- `key`: The dictionary key to extract from observations

**Core Methods**:

- `reset()`:
  - **Function**: Reset environment and extract specified key from dictionary observation.
  - **Return Value**: Numpy array containing the extracted observation value
  - **Details**: Asserts that observation is a dictionary and extracts the specified key.

- `step_wait()`:
  - **Function**: Wait for step results and extract specified key from observations.
  - **Return Value**: Tuple of (extracted_observation, rewards, dones, infos)
  - **Details**: Also handles terminal observations in info dictionaries by extracting the same key.

**Features**:
- Simplifies dictionary observation spaces by extracting single components
- Maintains compatibility with algorithms expecting single-array observations
- Automatically handles terminal observation extraction
- Validates that wrapped environment has dictionary observation space

**Use Cases**:
- Using multi-input policies with single-input algorithms
- Extracting specific components from complex observation dictionaries
- Simplifying environment interfaces for testing and debugging
- Transitioning from multi-modal to single-modal observations


#### 217. `VecFrameStack` Class - Frame Stacking Wrapper

**Function**: Vectorized environment wrapper that stacks multiple frames to provide temporal context, primarily designed for image observations.

**Class Definition**:

```python
from stable_baselines3.common.vec_env.vec_env_wrapper import VecEnvWrapper
class VecFrameStack(VecEnvWrapper):
  """
  Frame stacking wrapper for vectorized environment. Designed for image observations.

  :param venv: Vectorized environment to wrap
  :param n_stack: Number of frames to stack
  :param channels_order: If "first", stack on first image dimension. If "last", stack on last dimension.
      If None, automatically detect channel to stack over in case of image observation or default to "last" (default).
      Alternatively channels_order can be a dictionary which can be used with environments with Dict observation spaces
  """
  def __init__(self, venv: VecEnv, n_stack: int, channels_order: Optional[Union[str, Mapping[str, str]]] = None) -> None:
      ...
  def step_wait(self) -> tuple[Union[np.ndarray, dict[str, np.ndarray]], np.ndarray, np.ndarray, list[dict[str, Any]]]:
      ...
  def reset(self) -> Union[np.ndarray, dict[str, np.ndarray]]:
      ...
```

**Key Parameters**:
- `venv`: Vectorized environment to wrap
- `n_stack`: Number of frames to stack
- `channels_order`: Channel ordering for stacking ("first", "last", or automatic)

**Core Methods**:

- `step_wait()`:
  - **Function**: Wait for step results and update frame stack with new observations.
  - **Return Value**: Tuple of (stacked_observations, rewards, dones, infos)
  - **Details**: Uses StackedObservations helper to maintain temporal consistency and handle episode boundaries.

- `reset()`:
  - **Function**: Reset environment and initialize frame stack.
  - **Return Value**: Stacked initial observations
  - **Details**: Initializes stack with repeated initial frame to maintain consistent dimensionality.

**Features**:
- Supports both Box and Dict observation spaces
- Automatic channel ordering detection for image observations
- Handles episode termination properly by resetting individual environment stacks
- Maintains temporal consistency across frames
- Compatible with vectorized environments

**Use Cases**:
- Providing temporal information for Atari and other video game environments
- Enabling motion detection in pixel-based observations
- Improving policy performance in partially observable environments
- Maintaining compatibility with algorithms expecting single-frame inputs while providing multi-frame context

#### 218. `VecMonitor` Class - Vectorized Environment Monitor

**Function**: Vectorized monitor wrapper that records episode statistics (reward, length, time) for vectorized environments and optionally logs to file.

**Class Definition**:

```python
class VecMonitor(VecEnvWrapper):
  """
  A vectorized monitor wrapper for *vectorized* Gym environments,
  it is used to record the episode reward, length, time and other data.

  Some environments like `openai/procgen <https://github.com/openai/procgen>`_
  or `gym3 <https://github.com/openai/gym3>`_ directly initialize the
  vectorized environments, without giving us a chance to use the ``Monitor``
  wrapper. So this class simply does the job of the ``Monitor`` wrapper on
  a vectorized level.

  :param venv: The vectorized environment
  :param filename: the location to save a log file, can be None for no log
  :param info_keywords: extra information to log, from the information return of env.step()
  """
  def __init__(
      self,
      venv: VecEnv,
      filename: Optional[str] = None,
      info_keywords: tuple[str, ...] = (),
  ):
      ...
  def reset(self) -> VecEnvObs:
      ...
  def step_wait(self) -> VecEnvStepReturn:
      ...
  def close(self) -> None:
      ...
```

**Key Parameters**:
- `venv`: Vectorized environment to monitor
- `filename`: Log file path for recording statistics (optional)
- `info_keywords`: Additional info keys to record from environment step

**Core Methods**:

- `reset()`:
  - **Function**: Reset environment and clear episode statistics.
  - **Return Value**: Initial observations
  - **Details**: Resets episode return and length counters for all environments.

- `step_wait()`:
  - **Function**: Collect step results and update episode statistics.
  - **Return Value**: Tuple of (observations, rewards, dones, enhanced_infos)
  - **Details**: Accumulates rewards and lengths, creates episode summaries when episodes end, and writes to log file if configured.

- `close()`:
  - **Function**: Close monitor and underlying environment.
  - **Details**: Closes results writer if active and propagates close to wrapped environment.

**Recorded Statistics**:
- `r`: Episode return (cumulative reward)
- `l`: Episode length (number of steps)
- `t`: Episode timestamp relative to monitor start
- Custom metrics specified in `info_keywords`

**Features**:
- Compatible with vectorized environments that don't support individual Monitor wrappers
- Real-time episode statistics tracking
- Optional CSV logging for analysis and visualization
- Support for custom information keywords from environment
- Proper handling of simultaneous episode terminations across environments

**Use Cases**:
- Monitoring training progress in vectorized environments
- Logging performance metrics for analysis
- Environments like Procgen or gym3 that initialize as vectorized environments
- Replacing individual Monitor wrappers in vectorized setups

#### 219. VecTransposeImage class - Transpose image channels for vectorized environments
**Function**:  
Reorders image observation channels from HxWxC (channels last) to CxHxW (channels first), which is required for PyTorch convolutional layers.

**Class Definition**:
```python
class VecTransposeImage(VecEnvWrapper):
  """
  Re-order channels, from HxWxC to CxHxW.
  It is required for PyTorch convolution layers.

  :param venv:
  :param skip: Skip this wrapper if needed as we rely on heuristic to apply it or not,
      which may result in unwanted behavior, see GH issue #671.
  """
  def __init__(self, venv: VecEnv, skip: bool = False): ...
  @staticmethod
  def transpose_space(observation_space: spaces.Box, key: str = "") -> spaces.Box: ...
  @staticmethod
  def transpose_image(image: np.ndarray) -> np.ndarray: ...
  def transpose_observations(self, observations: Union[np.ndarray, dict]) -> Union[np.ndarray, dict]: ...
  def step_wait(self) -> VecEnvStepReturn: ...
  def reset(self) -> Union[np.ndarray, dict]: ...
  def close(self) -> None: ...
```

**Key Parameters**:
- `venv` (VecEnv): The vectorized environment instance to wrap.
- `skip` (bool): If True, disables transposition logic (used when heuristics may misapply this wrapper).

**Methods**:

- `__init__(venv, skip=False)`  
  - **Function**: Initialize wrapper, detect image observation spaces, and prepare transposed observation space structure.  
  - **Parameters**:  
    - `venv`: Base vectorized environment.  
    - `skip`: Whether to bypass transposition.  
  - **Details**:  
    - Handles both single `Box` spaces and dictionary-based observation spaces.  
    - Modifies image-space entries only.  

- `transpose_space(observation_space, key="")`  
  - **Function**: Transpose a single observation space’s shape from (H, W, C) to (C, H, W).  
  - **Parameters**:  
    - `observation_space` (spaces.Box): Original observation space.  
    - `key` (str): Optional key for dictionary observation spaces.  
  - **Return Value**: `spaces.Box` with transposed shape.  

- `transpose_image(image)`  
  - **Function**: Reorder image or batch dimensions for NumPy arrays.  
  - **Parameters**:  
    - `image` (np.ndarray): Image array to transpose.  
  - **Return Value**: Transposed np.ndarray.  
  - **Details**: Handles both 3D (single image) and 4D (batched) tensors.  

- `transpose_observations(observations)`  
  - **Function**: Apply channel transposition to observation data (dict or array).  
  - **Parameters**:  
    - `observations` (Union[np.ndarray, dict]): Observations to transform.  
  - **Return Value**: Transposed observation structure.  
  - **Details**: Skips operation if `self.skip` is True; deep-copies dict observations to avoid mutation.  

- `step_wait()`  
  - **Function**: Wait for environment step results and transpose all observations and terminal observations.  
  - **Return Value**: `VecEnvStepReturn` (transposed observations, rewards, dones, infos).  

- `reset()`  
  - **Function**: Reset the wrapped environment and transpose its observations.  
  - **Return Value**: Transposed np.ndarray or dict.  

- `close()`  
  - **Function**: Close the wrapped vectorized environment.  
  - **Return Value**: None.  

#### 220. VecVideoRecorder class - Record rendered frames from vectorized environments as videos
**Function**:  
A vectorized environment wrapper that records rendered frames from environments and saves them as `.mp4` videos using MoviePy.  
Recording is triggered by a user-defined function based on environment step count.

**Class Definition**:
```python
class VecVideoRecorder(VecEnvWrapper):
  """
  Wraps a VecEnv or VecEnvWrapper object to record rendered image as mp4 video.
  It requires ffmpeg or avconv to be installed on the machine.

  Note: for now it only allows to record one video and all videos
  must have at least two frames.

  The video recorder code was adapted from Gymnasium v1.0.

  :param venv:
  :param video_folder: Where to save videos
  :param record_video_trigger: Function that defines when to start recording.
                                      The function takes the current number of step,
                                      and returns whether we should start recording or not.
  :param video_length:  Length of recorded videos
  :param name_prefix: Prefix to the video name
  """
  def __init__(
      self,
      venv: VecEnv,
      video_folder: str,
      record_video_trigger: Callable[[int], bool],
      video_length: int = 200,
      name_prefix: str = "rl-video",
  ): ...
  def reset(self) -> VecEnvObs: ...
  def _start_video_recorder(self) -> None: ...
  def _video_enabled(self) -> bool: ...
  def step_wait(self) -> VecEnvStepReturn: ...
  def _capture_frame(self) -> None: ...
  def close(self) -> None: ...
  def _start_recording(self) -> None: ...
  def _stop_recording(self) -> None: ...
  def __del__(self) -> None: ...
```

**Key Parameters**:
- `venv` (VecEnv): Vectorized environment to be wrapped.
- `video_folder` (str): Directory to save generated video files.
- `record_video_trigger` (Callable[[int], bool]): Function that determines when to start recording.
- `video_length` (int): Maximum number of frames per video. Default is 200.
- `name_prefix` (str): Prefix for generated video file names. Default is `"rl-video"`.

**Methods**:

- `__init__(venv, video_folder, record_video_trigger, video_length=200, name_prefix="rl-video")`  
  - **Function**: Initialize the video recorder wrapper.  
  - **Parameters**:  
    - `venv`: Wrapped environment.  
    - `video_folder`: Output directory.  
    - `record_video_trigger`: Step-based recording condition.  
    - `video_length`: Max video length.  
    - `name_prefix`: Output filename prefix.  
  - **Details**:  
    - Ensures `render_mode` is `"rgb_array"`.  
    - Retrieves environment metadata (`render_fps`) for video timing.  
    - Creates output directory if it doesn’t exist.  
    - Checks for MoviePy installation.  

- `reset()`  
  - **Function**: Reset the environment and start recording if trigger is active.  
  - **Return Value**: `VecEnvObs`.  

- `_start_video_recorder()`  
  - **Function**: Initialize video name and path, and start frame capture.  
  - **Return Value**: None.  
  - **Details**:  
    - Updates `video_name` and `video_path`.  
    - Starts recording session and captures first frame.  

- `_video_enabled()`  
  - **Function**: Determine whether recording should start based on trigger function.  
  - **Return Value**: bool.  

- `step_wait()`  
  - **Function**: Wait for environment steps and handle frame capture, video start/stop logic.  
  - **Return Value**: `VecEnvStepReturn`.  
  - **Details**:  
    - Increments step counter.  
    - Captures frames while recording.  
    - Stops recording and saves video when length limit reached.  

- `_capture_frame()`  
  - **Function**: Capture one frame from environment rendering.  
  - **Return Value**: None.  
  - **Details**:  
    - Appends frames as NumPy arrays to internal buffer.  
    - Stops recording and warns if returned frame type is invalid.  

- `close()`  
  - **Function**: Close the wrapper and finalize any active recording.  
  - **Return Value**: None.  

- `_start_recording()`  
  - **Function**: Begin a new video recording session.  
  - **Return Value**: None.  
  - **Details**:  
    - Stops any existing recording before starting a new one.  

- `_stop_recording()`  
  - **Function**: Finalize and save current recording using MoviePy.  
  - **Return Value**: None.  
  - **Details**:  
    - Saves video to disk if frames exist.  
    - Clears internal buffers and resets recording state.  

- `__del__()`  
  - **Function**: Warn if the object is deleted while frames remain unsaved.  
  - **Return Value**: None.  
  - **Details**:  
    - Emits warning through `logger.warn` if unsaved frames remain.  

#### 221. QNetwork class - Action-Value (Q-Value) estimator for DQN
**Function**:  
Implements a neural network mapping observations to Q-values for each discrete action.  
Used by DQN-based policies for action selection and value estimation.

**Class Definition**:
```python
class QNetwork(BasePolicy):
  """
  Action-Value (Q-Value) network for DQN

  :param observation_space: Observation space
  :param action_space: Action space
  :param net_arch: The specification of the policy and value networks.
  :param activation_fn: Activation function
  :param normalize_images: Whether to normalize images or not,
        dividing by 255.0 (True by default)
  """
  def __init__(
      self,
      observation_space: spaces.Space,
      action_space: spaces.Discrete,
      features_extractor: BaseFeaturesExtractor,
      features_dim: int,
      net_arch: Optional[list[int]] = None,
      activation_fn: type[nn.Module] = nn.ReLU,
      normalize_images: bool = True,
  ): ...
  def forward(self, obs: PyTorchObs) -> th.Tensor: ...
  def _predict(self, observation: PyTorchObs, deterministic: bool = True) -> th.Tensor: ...
  def _get_constructor_parameters(self) -> dict[str, Any]: ...
```

**Key Parameters**:
- `observation_space` (spaces.Space): Input observation space.
- `action_space` (spaces.Discrete): Discrete action space.
- `features_extractor` (BaseFeaturesExtractor): Module for observation feature extraction.
- `features_dim` (int): Dimension of extracted features.
- `net_arch` (list[int], optional): Hidden layer sizes for the Q-network (default `[64, 64]`).
- `activation_fn` (nn.Module): Activation function (default `nn.ReLU`).
- `normalize_images` (bool): Whether to normalize input images by 255 (default `True`).

**Methods**:
- `__init__()`:  
  - Builds the fully connected Q-network with the provided architecture.  
  - Converts feature outputs into action-value predictions.

- `forward(obs)`:  
  - **Function**: Compute Q-values for all actions.  
  - **Return**: `th.Tensor` — predicted Q-values of shape `[batch_size, n_actions]`.

- `_predict(observation, deterministic=True)`:  
  - **Function**: Selects greedy action (`argmax(Q)`).
  - **Return**: `th.Tensor` — chosen action indices.

- `_get_constructor_parameters()`:  
  - **Function**: Return initialization parameters for saving/loading models.


#### 222. DQNPolicy class - Deep Q-Network policy with target network
**Function**:  
Defines the core DQN policy containing two Q-networks (main and target) and their optimizer.  
Handles training/evaluation mode and model construction.

**Class Definition**:
```python
class DQNPolicy(BasePolicy):
    def __init__(
        self,
        observation_space: spaces.Space,
        action_space: spaces.Discrete,
        lr_schedule: Schedule,
        net_arch: Optional[list[int]] = None,
        activation_fn: type[nn.Module] = nn.ReLU,
        features_extractor_class: type[BaseFeaturesExtractor] = FlattenExtractor,
        features_extractor_kwargs: Optional[dict[str, Any]] = None,
        normalize_images: bool = True,
        optimizer_class: type[th.optim.Optimizer] = th.optim.Adam,
        optimizer_kwargs: Optional[dict[str, Any]] = None,
    )-> None: ...
    def _build(self, lr_schedule: Schedule) -> None: ...
    def make_q_net(self) -> QNetwork: ...
    def forward(self, obs: PyTorchObs, deterministic: bool = True) -> th.Tensor: ...
    def _predict(self, obs: PyTorchObs, deterministic: bool = True) -> th.Tensor: ...
    def _get_constructor_parameters(self) -> dict[str, Any]: ...
    def set_training_mode(self, mode: bool) -> None: ...
```

**Key Parameters**:
- `observation_space` (spaces.Space): Observation space.
- `action_space` (spaces.Discrete): Discrete action space.
- `lr_schedule` (Schedule): Learning rate schedule function.
- `net_arch` (list[int], optional): Q-network architecture. Defaults to `[64, 64]` (empty for CNN).
- `activation_fn` (nn.Module): Activation function for layers.
- `features_extractor_class` (BaseFeaturesExtractor): Type of feature extractor (default `FlattenExtractor`).
- `features_extractor_kwargs` (dict, optional): Keyword args for the feature extractor.
- `normalize_images` (bool): Whether to normalize pixel inputs.
- `optimizer_class` (th.optim.Optimizer): Optimizer type (default `Adam`).
- `optimizer_kwargs` (dict, optional): Additional optimizer parameters.

**Attributes**:
- `q_net`: Main Q-network.
- `q_net_target`: Target Q-network for stable updates.
- `optimizer`: Optimizer for Q-network parameters.

**Methods**:
- `__init__()`:  
  - Sets up architecture, feature extractor, and optimizer.  
  - Calls `_build()` to initialize Q-networks.

- `_build(lr_schedule)`:  
  - Creates `q_net` and `q_net_target`.  
  - Synchronizes target parameters and sets evaluation mode.  
  - Initializes optimizer with learning rate from schedule.

- `make_q_net()`:  
  - Instantiates a new QNetwork with current policy parameters.

- `forward(obs, deterministic=True)`:  
  - Returns predicted actions by delegating to `_predict`.

- `_predict(obs, deterministic=True)`:  
  - Computes greedy actions via main Q-network.

- `_get_constructor_parameters()`:  
  - Returns constructor parameters for saving/loading.

- `set_training_mode(mode)`:  
  - Toggles between training and evaluation mode for all networks.



#### 223. MlpPolicy alias
**Definition**:  
```python
MlpPolicy = DQNPolicy
```
**Function**:  
Alias for `DQNPolicy` when using standard MLP (non-image) inputs.



#### 224. CnnPolicy class - DQN policy for image-based inputs
**Function**:  
Extension of `DQNPolicy` using a CNN-based feature extractor (`NatureCNN`).  
Optimized for visual observations.

**Class Definition**:
```python
class CnnPolicy(DQNPolicy):
  """
  Policy class for DQN when using images as input.

  :param observation_space: Observation space
  :param action_space: Action space
  :param lr_schedule: Learning rate schedule (could be constant)
  :param net_arch: The specification of the policy and value networks.
  :param activation_fn: Activation function
  :param features_extractor_class: Features extractor to use.
  :param normalize_images: Whether to normalize images or not,
        dividing by 255.0 (True by default)
  :param optimizer_class: The optimizer to use,
      ``th.optim.Adam`` by default
  :param optimizer_kwargs: Additional keyword arguments,
      excluding the learning rate, to pass to the optimizer
  """
  def __init__(
      self,
      observation_space: spaces.Space,
      action_space: spaces.Discrete,
      lr_schedule: Schedule,
      net_arch: Optional[list[int]] = None,
      activation_fn: type[nn.Module] = nn.ReLU,
      features_extractor_class: type[BaseFeaturesExtractor] = NatureCNN,
      features_extractor_kwargs: Optional[dict[str, Any]] = None,
      normalize_images: bool = True,
      optimizer_class: type[th.optim.Optimizer] = th.optim.Adam,
      optimizer_kwargs: Optional[dict[str, Any]] = None,
  ) -> None: ...

```

**Key Parameters**:
- Uses same arguments as `DQNPolicy`.
- Default `features_extractor_class` is `NatureCNN` for visual input.
- `net_arch` defaults to an empty list when using CNN features.

**Behavior**:
- Inherits all methods and attributes from `DQNPolicy`.


#### 225. MultiInputPolicy class - DQN policy for multi-modal (dict) observations
**Function**:  
Variant of `DQNPolicy` using `CombinedExtractor` for dict-based observation spaces.  
Designed for environments where input includes multiple sensor modalities.

**Class Definition**:
```python
class MultiInputPolicy(DQNPolicy):
  """
  Policy class for DQN when using dict observations as input.

  :param observation_space: Observation space
  :param action_space: Action space
  :param lr_schedule: Learning rate schedule (could be constant)
  :param net_arch: The specification of the policy and value networks.
  :param activation_fn: Activation function
  :param features_extractor_class: Features extractor to use.
  :param normalize_images: Whether to normalize images or not,
        dividing by 255.0 (True by default)
  :param optimizer_class: The optimizer to use,
      ``th.optim.Adam`` by default
  :param optimizer_kwargs: Additional keyword arguments,
      excluding the learning rate, to pass to the optimizer
  """
  def __init__(
      self,
      observation_space: spaces.Dict,
      action_space: spaces.Discrete,
      lr_schedule: Schedule,
      net_arch: Optional[list[int]] = None,
      activation_fn: type[nn.Module] = nn.ReLU,
      features_extractor_class: type[BaseFeaturesExtractor] = CombinedExtractor,
      features_extractor_kwargs: Optional[dict[str, Any]] = None,
      normalize_images: bool = True,
      optimizer_class: type[th.optim.Optimizer] = th.optim.Adam,
      optimizer_kwargs: Optional[dict[str, Any]] = None,
  )-> None: ...
```

**Key Parameters**:
- Inherits parameters from `DQNPolicy`.
- Uses `CombinedExtractor` by default for dict observation handling.
- Enables feature fusion from heterogeneous observation components.

**Behavior**:
- Retains all DQN training and inference functionality.
- Suitable for multi-input (e.g., visual + vector) tasks.

#### 226. unwrap_vec_wrapper function  
**Function**:  
Recursively searches through a vectorized environment (`VecEnv`) to locate and return the first instance of a specific `VecEnvWrapper` subclass.

**Definition**:
```python
def unwrap_vec_wrapper(env: VecEnv, vec_wrapper_class: type[VecEnvWrapperT]) -> Optional[VecEnvWrapperT]:
  """
  Retrieve a ``VecEnvWrapper`` object by recursively searching.

  :param env: The ``VecEnv`` that is going to be unwrapped
  :param vec_wrapper_class: The desired ``VecEnvWrapper`` class.
  :return: The ``VecEnvWrapper`` object if the ``VecEnv`` is wrapped with the desired wrapper, None otherwise
  """
```

**Parameters**:
- `env` (`VecEnv`): The vectorized environment to unwrap.
- `vec_wrapper_class` (`type[VecEnvWrapperT]`): The wrapper class type to search for.

**Returns**:  
- `VecEnvWrapperT` — The found wrapper instance.  
- `None` — If the target wrapper type is not found.

**Behavior**:  
Iteratively traverses the chain of wrappers (`env.venv`) until it either finds a wrapper matching `vec_wrapper_class` or reaches an unwrapped base environment.



#### 227. unwrap_vec_normalize function  
**Function**:  
Shortcut utility to specifically locate a `VecNormalize` wrapper inside a wrapped environment.

**Definition**:
```python
def unwrap_vec_normalize(env: VecEnv) -> Optional[VecNormalize]:
    """
    Retrieve a ``VecNormalize`` object by recursively searching.

    :param env: The VecEnv that is going to be unwrapped
    :return: The ``VecNormalize`` object if the ``VecEnv`` is wrapped with ``VecNormalize``, None otherwise
    """
    return unwrap_vec_wrapper(env, VecNormalize)

```

**Parameters**:
- `env` (`VecEnv`): The vectorized environment to search.

**Returns**:  
- `VecNormalize` — If found.  
- `None` — If not found.

**Behavior**:  
Internally calls `unwrap_vec_wrapper(env, VecNormalize)`.


#### 228. is_vecenv_wrapped function  
**Function**:  
Checks whether a given vectorized environment is already wrapped by a specific wrapper class.

**Definition**:
```python
def is_vecenv_wrapped(env: VecEnv, vec_wrapper_class: type[VecEnvWrapper]) -> bool:
    """
    Check if an environment is already wrapped in a given ``VecEnvWrapper``.

    :param env: The VecEnv that is going to be checked
    :param vec_wrapper_class: The desired ``VecEnvWrapper`` class.
    :return: True if the ``VecEnv`` is wrapped with the desired wrapper, False otherwise
    """
    return unwrap_vec_wrapper(env, vec_wrapper_class) is not None

```

**Parameters**:
- `env` (`VecEnv`): The environment to inspect.
- `vec_wrapper_class` (`type[VecEnvWrapper]`): The wrapper class to check for.

**Returns**:  
- `True` — If the environment is wrapped by the specified wrapper class.  
- `False` — Otherwise.

**Behavior**:  
Delegates to `unwrap_vec_wrapper` and evaluates whether a wrapper instance exists.



#### 229. sync_envs_normalization function  
**Function**:  
Synchronizes the running normalization statistics between a training environment and an evaluation environment, assuming both are wrapped with `VecNormalize`.

**Definition**:
```python
def sync_envs_normalization(env: VecEnv, eval_env: VecEnv) -> None:
  """
    Synchronize the normalization statistics of an eval environment and train environment
    when they are both wrapped in a ``VecNormalize`` wrapper.

    :param env: Training env
    :param eval_env: Environment used for evaluation.
    """
```

**Parameters**:
- `env` (`VecEnv`): Training environment containing reference normalization statistics.
- `eval_env` (`VecEnv`): Evaluation environment to be synchronized.

**Behavior**:
- Traverses both environments’ wrapper chains simultaneously.  
- Asserts structural parity between training and evaluation wrappers.  
- When encountering a `VecNormalize` wrapper:
  - Copies observation RMS (`obs_rms`) if available.  
  - Copies return RMS (`ret_rms`).
- Ensures matching wrapper hierarchy for consistent normalization transfer.
#### 230 is_image_space_channels_first Function  
**Function**:  
Checks whether the observation space of a vectorized environment is image-based with channels first (CxHxW) format.
```python
def is_image_space_channels_first(observation_space: spaces.Box) -> bool:
    """
    Check if an image observation space (see ``is_image_space``)
    is channels-first (CxHxW, True) or channels-last (HxWxC, False).

    Use a heuristic that channel dimension is the smallest of the three.
    If second dimension is smallest, raise an exception (no support).

    :param observation_space:
    :return: True if observation space is channels-first image, False if channels-last.
    """
```
**Parameters**:
- `observation_space` (`spaces.Box`): The observation space to check.

**Returns**:  
- `True` — If channels-first (CxHxW).  
- `False` — If channels-last (HxWxC).

**Behavior**:  
- Examines the shape of the observation space.  
- Asserts that the channel dimension is the smallest.  
- Raises an exception if the second dimension is not the smallest (no support for such layouts).  

#### 231 maybe_transpose Function  
**Function**:  
Handles the transposition of image observations between channels-first (CxHxW) and channels-last (HxWxC) formats, as required by PyTorch.

**Definition**:
```python
def maybe_transpose(observation: np.ndarray, observation_space: spaces.Space) -> np.ndarray:
    """
    Handle the different cases for images as PyTorch use channel first format.

    :param observation:
    :param observation_space:
    :return: channel first observation if observation is an image
    """
```
**Parameters**:
- `observation` (`np.ndarray`): The image observation to transpose.
- `observation_space` (`spaces.Space`): The observation space of the environment.

**Returns**:  
- `np.ndarray` — Transposed image observation if it is an image space, otherwise the original observation.

#### 232. DISABLED Constants
```python
DISABLED = 50
```

### Supported Algorithm Types

- **Policy Gradient Methods**: PPO, A2C
- **Value Function Methods**: DQN
- **Actor-Critic Methods**: SAC, TD3, DDPG
- **Special Algorithms**: HER (Hindsight Experience Replay)

### Supported Environment Types

- **Classical Control**: CartPole, Pendulum, Acrobot
- **Atari Games**: Breakout, Pong, SpaceInvaders
- **Box2D Physics**: LunarLander, BipedalWalker
- **MuJoCo Physics**: HalfCheetah, Hopper, Walker2d
- **Custom Environments**: Support any environment that conforms to the Gymnasium interface

### Error Handling

The system provides a comprehensive error handling mechanism:
- **Environment Check**: Automatically verify the compliance of the environment interface
- **Parameter Validation**: Check the validity of hyperparameters
- **Memory Management**: Automatically handle GPU memory allocation
- **Exception Capture**: Gracefully handle exceptions during training

### Important Notes

1. **Environment Compatibility**: Ensure that the environment conforms to the Gymnasium interface specification.
2. **Memory Management**: Pay attention to GPU memory usage for large models.
3. **Random Seeds**: Set random seeds to ensure reproducible results.
4. **Vectorized Environments**: Use vectorized environments to improve training efficiency.
5. **Callback Functions**: Use callback functions reasonably to monitor the training process.

## Detailed Function Implementation Nodes

### Node 1: Environment Monitoring and Logging Function (Monitor)

**Function Description**: Monitor the environment interaction process, automatically record information such as the reward, length, and time of each episode, and save the logs as a CSV file for subsequent analysis and visualization.

**Core Algorithm**:
- Wrap the original environment and intercept step/reset calls.
- Automatically record episode statistics.
- Support writing custom metadata.
- Automatically create and append log files.

**Input/Output Example**:

```python
import gymnasium as gym
from stable_baselines3.common.monitor import Monitor

# Wrap the environment and specify the log file
env = Monitor(gym.make("CartPole-v1"), filename="monitor.csv")

obs, _ = env.reset()
done = False
while not done:
    action = env.action_space.sample()
    obs, reward, done, truncated, info = env.step(action)

# The log file monitor.csv is automatically generated, containing episode rewards, lengths, times, etc.
```

**Standardized Interface**:
```python
class Monitor:
    def __init__(self, env, filename=None, allow_early_resets=True, reset_keywords=()):
        # Initialize the monitor
        pass
    
    def step(self, action):
        # Record step information
        pass
    
    def reset(self, **kwargs):
        # Record reset information
        pass
```

### Node 2: Experience Replay Buffer (ReplayBuffer)

**Function Description**: Store the experience data of the agent's interaction with the environment, support batch sampling for off-policy algorithm training, and improve sample utilization.

**Core Algorithm**:
- Store the five-tuple (obs, action, reward, next_obs, done).
- Support batch sampling and circular overwriting.
- Can be extended to variants such as HER and prioritized replay.

**Input/Output Example**:

```python
from stable_baselines3.common.buffers import ReplayBuffer

buffer = ReplayBuffer(
    buffer_size=10000,
    observation_space=env.observation_space,
    action_space=env.action_space,
    device="cpu"
)

# Add experience
buffer.add(obs, next_obs, action, reward, done, infos)

# Batch sampling
batch = buffer.sample(batch_size=32)
print(batch.observations.shape)  # (32, obs_dim)
```

**Standardized Interface**:
```python
class ReplayBuffer:
    def add(self, obs, next_obs, action, reward, done, infos):
        # Add experience to the buffer
        pass
    
    def sample(self, batch_size):
        # Sample an experience batch
        pass
    
    def __len__(self):
        # Return the buffer size
        pass
```

### Node 3: Model Saving and Loading (Save/Load)

**Function Description**: Support saving the trained model parameters, structure, hyperparameters, etc. completely to disk, and load and resume training or inference at any time.

**Core Algorithm**:
- Save model weights, optimizer states, and hyperparameters.
- Support saving custom objects.
- Specify a new environment or device when loading.

**Input/Output Example**:

```python
from stable_baselines3 import PPO

model = PPO("MlpPolicy", env)
model.learn(total_timesteps=10000)

# Save the model
model.save("ppo_cartpole")

# Load the model
loaded_model = PPO.load("ppo_cartpole", env=env)
```

**Standardized Interface**:
```python
class BaseAlgorithm:
    def save(self, path):
        # Save the model to the specified path
        pass
    
    @classmethod
    def load(cls, path, env=None, device="auto"):
        # Load the model from the specified path
        pass
```

### Node 4: Callback Function System (Callback)

**Function Description**: Insert custom logic during the training process to implement functions such as model saving, evaluation, early stopping, and logging, and improve the flexibility and controllability of the training process.

**Core Algorithm**:
- Define hooks such as on_step/on_training_end.
- Support combining multiple callbacks.
- Provide common callbacks such as CheckpointCallback, EvalCallback, and StopTrainingOnRewardThreshold.

**Input/Output Example**:

```python
from stable_baselines3.common.callbacks import CheckpointCallback, EvalCallback

checkpoint_callback = CheckpointCallback(save_freq=1000, save_path="./models/")
eval_callback = EvalCallback(eval_env, eval_freq=500)

model.learn(total_timesteps=10000, callback=[checkpoint_callback, eval_callback])
```

**Standardized Interface**:
```python
class BaseCallback:
    def on_step(self):
        # Called at each step
        pass
    
    def on_training_end(self):
        # Called when training ends
        pass
```

### Node 5: Vectorized Environment (VecEnv)

**Function Description**: Run multiple environment instances in parallel to improve sampling efficiency, support multiple implementations such as DummyVecEnv (single-process) and SubprocVecEnv (multi-process).

**Core Algorithm**:
- Parallel reset/step.
- Support standardization of observations and rewards.
- Be compatible with custom environments and wrappers.

**Input/Output Example**:

```python
from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv

# Single-process vectorization
env = DummyVecEnv([lambda: gym.make("CartPole-v1") for _ in range(4)])

# Multi-process vectorization
env = SubprocVecEnv([lambda: gym.make("CartPole-v1") for _ in range(8)])

obs = env.reset()
actions = [env.action_space.sample() for _ in range(env.num_envs)]
obs, rewards, dones, infos = env.step(actions)
```

**Standardized Interface**:
```python
class VecEnv:
    def reset(self):
        # Reset all environments
        pass
    
    def step(self, actions):
        # Perform actions in all environments
        pass
    
    def close(self):
        # Close all environments
        pass
```

### Node 6: Environment Interface Compliance Check (Env Checker)

**Function Description**: Automatically check whether a custom environment conforms to the Gymnasium interface specification and detect potential compatibility issues in advance.

**Core Algorithm**:
- Check the format of reset/step return values.
- Verify the definitions of observation and action spaces.
- Output detailed error prompts.

**Input/Output Example**:

```python
from stable_baselines3.common.env_checker import check_env

check_env(env)  # Throw an exception and give detailed instructions if non-compliant
```

**Standardized Interface**:
```python
def check_env(env, warn=True):
    # Check the compliance of the environment interface
    # Return the check result or throw an exception
    pass
```

### Node 7: Deterministic Testing and Random Seeds (Deterministic Test & Seed)

**Function Description**: Ensure the reproducibility of the training and inference processes by setting random seeds, and support consistency testing across multiple environments and algorithms.

**Core Algorithm**:
- Set random seeds for numpy, torch, the environment, etc.
- Support consistency in multi-process environments.
- Provide test cases to verify the consistency of results.

**Input/Output Example**:

```python
from stable_baselines3.common.utils import set_random_seed

set_random_seed(42)
env.seed(42)
model = PPO("MlpPolicy", env, seed=42)
```

**Standardized Interface**:
```python
def set_random_seed(seed, using_cuda=False):
    # Set all random seeds
    pass
```

### Node 8: Model Evaluation and Performance Statistics (Evaluation)

**Function Description**: Evaluate the trained model,统计 average rewards, success rates, and other indicators, support multi-episode evaluation, and custom evaluation environments.

**Core Algorithm**:
- Multi-episode rollout.
- 统计 rewards, lengths, and success rates.
- Support custom evaluation callbacks.

**Input/Output Example**:

```python
from stable_baselines3.common.evaluation import evaluate_policy

mean_reward, std_reward = evaluate_policy(model, env, n_eval_episodes=10)
print(f"Mean Reward: {mean_reward}, Standard Deviation: {std_reward}")
```

**Standardized Interface**:
```python
def evaluate_policy(model, env, n_eval_episodes=10, deterministic=True):
    # Evaluate the model performance
    # Return the average reward and standard deviation
    pass
```

### Node 9: Action Distribution Processing (Distribution)

**Function Description**: Automatically select an appropriate probability distribution according to the action space type (discrete/continuous), implement action sampling, probability calculation, entropy calculation, etc., and support the distributed output of policy gradient algorithms.

**Core Algorithm**:
- Use the Categorical distribution for discrete action spaces and the Normal distribution for continuous action spaces.
- Support distribution parameterization (mean, variance, etc.).
- Provide interfaces such as sampling, log_prob, and entropy.

**Input/Output Example**:
```python
from stable_baselines3.common.distributions import make_proba_distribution

dist = make_proba_distribution(env.action_space)
action = dist.sample()
log_prob = dist.log_prob(action)
entropy = dist.entropy()
```

**Standardized Interface**:
```python
class Distribution:
    def sample(self):
        pass
    def log_prob(self, actions):
        pass
    def entropy(self):
        pass
```

---

### Node 10: Exploration Noise Injection (Noise)

**Function Description**: Inject noise during the action selection process to improve exploration, support multiple noise types such as Ornstein-Uhlenbeck and Gaussian, and are commonly used in algorithms such as DDPG and TD3.

**Core Algorithm**:
- Initialize noise parameters.
- Generate and decay noise.
- Add noise to actions.

**Input/Output Example**:
```python
from stable_baselines3.common.noise import OrnsteinUhlenbeckActionNoise
import numpy as np

noise = OrnsteinUhlenbeckActionNoise(mean=np.zeros(1), sigma=0.1)
noisy_action = action + noise()
```

**Standardized Interface**:
```python
class ActionNoise:
    def __call__(self):
        pass
    def reset(self):
        pass
```

---

### Node 11: Data Preprocessing (Preprocessing)

**Function Description**: Preprocess data such as observations and rewards, including standardization, normalization, frame stacking, etc., to improve training stability and generalization ability.

**Core Algorithm**:
- Calculate running mean and variance statistics.
- Standardize observations/rewards.
- Stack image frames.

**Input/Output Example**:
```python
from stable_baselines3.common.preprocessing import preprocess_obs
obs_norm = preprocess_obs(obs, env.observation_space)

from stable_baselines3.common.vec_env import VecFrameStack
env = VecFrameStack(env, n_stack=4)
```

**Standardized Interface**:
```python
def preprocess_obs(obs, observation_space):
    pass
```

---

### Node 12: Policy Networks

**Function Description**: Supports various policy network structures such as custom MLP, CNN, and RNN to meet the needs of different tasks.

**Core Algorithms**:
- Inherit the BasePolicy base class.
- Implement methods such as forward, actor, and critic.
- Support feature extractor sharing.

**Input-Output Example**:
```python
from stable_baselines3.common.policies import BasePolicy
import torch.nn as nn

class CustomPolicy(BasePolicy):
    def __init__(self, observation_space, action_space, lr_schedule):
        super().__init__(observation_space, action_space, lr_schedule)
        self.net = nn.Sequential(
            nn.Linear(observation_space.shape[0], 64),
            nn.ReLU(),
            nn.Linear(64, 64),
            nn.ReLU()
        )
    def forward(self, obs, deterministic=False):
        return self.net(obs)

model = PPO(CustomPolicy, env)
```

**Standardized Interface**:
```python
class BasePolicy:
    def forward(self, obs, deterministic=False):
        pass
```

---

### Node 13: Training Loop

**Function Description**: Implements the main training loop, including sampling, updating, callbacks, and logging. Supports resuming training from a breakpoint and various training modes.

**Core Algorithms**:
- Sample data.
- Calculate loss and perform backpropagation.
- Call callbacks and log information.
- Support resuming training from a breakpoint.

**Input-Output Example**:
```python
model.learn(total_timesteps=100000, callback=callback)
```

**Standardized Interface**:
```python
class BaseAlgorithm:
    def learn(self, total_timesteps, callback=None):
        pass
```

---

### Node 14: Gradient Computation and Optimization

**Function Description**: Implements loss functions, gradient computation, and parameter optimization. Supports various optimizers and custom losses.

**Core Algorithms**:
- Define loss functions.
- Perform backpropagation and gradient clipping.
- Take optimizer steps.

**Input-Output Example**:
```python
loss = compute_loss(batch)
loss.backward()
optimizer.step()
```

**Standardized Interface**:
```python
class BaseAlgorithm:
    def compute_loss(self, batch):
        pass
    def optimizer_step(self):
        pass
```

---

### Node 15: Multi-process Env

**Function Description**: Implements multi-process environment sampling through SubprocVecEnv to improve the efficiency of large-scale training.

**Core Algorithms**:
- Create multi-process environments.
- Communicate and synchronize between processes.
- Merge sampled data.

**Input-Output Example**:
```python
from stable_baselines3.common.vec_env iSubprocVecEnvmport SubprocVecEnv

env = SubprocVecEnv([lambda: gym.make("CartPole-v1") for _ in range(8)])
obs = env.reset()
```

**Standardized Interface**:
```python
class SubprocVecEnv(VecEnv):
    pass
```

---

### Node 16: Logging and Visualization

**Function Description**: Records and visualizes information such as rewards, losses, and parameters during the training process through tools like TensorBoard, facilitating debugging and analysis.

**Core Algorithms**:
- Collect log data.
- Use TensorBoard or custom visualization methods.
- Support output in various formats.

**Input-Output Example**:
```python
from stable_baselines3.common.logger import configure

configure(folder="./logs/", format_strings=["stdout", "log", "tensorboard"])
model.learn(total_timesteps=10000)
# tensorboard --logdir ./logs/
```

**Standardized Interface**:
```python
class Logger:
    def record(self, key, value):
        pass
    def dump(self, step):
        pass
```

---

### Node 17: Prioritized Replay Buffer

**Function Description**: Implements experience replay sampling based on priority metrics such as TD-Error, increasing the sampling probability of important samples and improving learning efficiency. Commonly used in off-policy algorithms such as DQN and DDPG.

**Core Algorithms**:
- Use SumTree or Segment Tree to store priorities and support fast sampling and updating.
- Calculate sample priorities based on TD-Error and perform power adjustment and importance sampling weight correction.
- Support priority updating, sampling batches, and bypass strategies.

**Input-Output Example**:

```python
from stable_baselines3.common.buffers import PrioritizedReplayBuffer

prb = PrioritizedReplayBuffer(buffer_size=100000, alpha=0.6, beta=0.4)
prb.add(obs, next_obs, action, reward, done, info)
batch, indices, weights = prb.sample(batch_size=64)
prb.update_priorities(indices, new_priorities)
```

**Standardized Interface**:
```python
class PrioritizedReplayBuffer(ReplayBuffer):
    def sample(self, batch_size):
        # Return (batch, indices, importance_weights)
        pass
    def update_priorities(self, indices, priorities):
        pass
```

---

### Node 18: State Dependent Exploration (SDE)

**Function Description**: Implements state-based noise (SDE) for exploration in continuous action spaces, which can replace simple Gaussian noise to obtain more stable exploration behavior. Commonly used in algorithms such as SAC and TD3.

**Core Algorithms**:
- Generate noise parameters based on the features or state vectors output by the policy network.
- Dynamically adjust the noise scale and support reset and decay strategies.
- Combine with the learning process and allow joint training of noise parameters.

**Input-Output Example**:

```python
from stable_baselines3.common.sde import StateDependentNoise

noise = StateDependentNoise(action_dim=env.action_space.shape[0])
noisy_action = action + noise(state)
noise.reset()
```

**Standardized Interface**:
```python
class StateDependentNoise:
    def __call__(self, state):
        # Return a noise vector based on the state
        pass
    def reset(self):
        pass
```

---

### Node 19: Model Export and Deployment

**Function Description**: Supports exporting trained models to formats such as TorchScript and ONNX for deployment and inference in environments without Python dependencies. Also provides a lightweight inference interface.

**Core Algorithms**:
- Use torch.jit.trace/torch.jit.script to export TorchScript.
- Export using ONNX and check input-output signatures.
- Provide an inference wrapper to load the exported model and perform forward computation.

**Input-Output Example**:

```python
model.save("ppo_cartpole")
model.export_torchscript("ppo_cartpole.pt")
model.export_onnx("ppo_cartpole.onnx", sample_input)

# Inference side
from stable_baselines3.common.inference import load_onnx
infer = load_onnx("ppo_cartpole.onnx")
actions = infer.predict(batch_obs)
```

**Standardized Interface**:
```python
class BaseAlgorithm:
    def export_torchscript(self, path):
        pass
    def export_onnx(self, path, sample_input):
        pass
```

---

### Node 20: AMP and Optimization

**Function Description**: Supports automatic mixed precision training (AMP) and common training acceleration strategies (gradient accumulation, multi-GPU training, distributed training interface) to reduce GPU memory usage and improve performance.

**Core Algorithms**:
- Use torch.cuda.amp.autocast and GradScaler to manage half-precision training.
- Support the integration of gradient_accumulation, synchronize gradients, and DistDataParallel.
- Provide configuration interfaces to enable/disable optimization options.

**Input-Output Example**:

```python
model = PPO("MlpPolicy", env, use_amp=True)
model.learn(total_timesteps=100000)
```

**Standardized Interface**:
```python
class BaseAlgorithm:
    def optimizer_step(self):
        # Support AMP step
        pass
```

---

### Node 21: Hyperparameter Tuning

**Function Description**: Integrates hyperparameter search tools (such as Optuna), supports defining search spaces, automated experiment management, and result recording, making it easy to find suitable training configurations.

**Core Algorithms**:
- Define searchable hyperparameter spaces and pass algorithm construction parameters during experiments.
- Support pruning strategies and parallel experiments.
- Write back the optimal configuration and save the corresponding model checkpoints.

**Input-Output Example**:

```python
from stable_baselines3.common.tuning import OptunaCallback, optimize

def objective(trial):
    lr = trial.suggest_loguniform('lr', 1e-5, 1e-3)
    model = PPO("MlpPolicy", env, learning_rate=lr)
    model.learn(total_timesteps=10000)
    return evaluate_policy(model, env, n_eval_episodes=5)[0]

best = optimize(objective, n_trials=20)
```

**Standardized Interface**:
```python
def optimize(objective_fn, n_trials, n_jobs=1):
    # Return the optimal hyperparameters and related results
    pass
```

---

### Node 22: Third-party Service Integration (WandB / Hugging Face, etc.)

**Function Description**: Provides integration with common experiment tracking and model repositories (Weights & Biases, Hugging Face Hub) for automatically recording training metrics, saving models, and sharing experiment results.

**Core Algorithms**:
- Synchronize metrics and models to third-party services in training callbacks.
- Support configuring API keys, project names, and automatic upload intervals.
- Provide tools for loading models and configurations from remote sources.

**Input-Output Example**:

```python
from stable_baselines3.common.integrations import WandbCallback

wb_cb = WandbCallback(project="sb3_experiments", save_model=True)
model.learn(total_timesteps=50000, callback=wb_cb)
```

**Standardized Interface**:
```python
class WandbCallback(BaseCallback):
    def __init__(self, project, save_model=False):
        pass
    def on_step(self):
        pass
```

---

### Node 23: Tests and CI

**Function Description**: Maintains a high-coverage unit test suite and integrates CI (GitHub Actions / GitLab CI) to automatically run tests, static checks, and type checks, ensuring code quality and reproducibility.

**Core Algorithms**:
- Write pytest test cases to cover common functions (env, buffers, algorithms, callbacks, etc.).
- Run lint, mypy, pytest, and build matrices (Python versions, CUDA options) in CI.
- Trigger conditions include PR, merge, and scheduled tasks.

**Input-Output Example**:

```yaml
# .github/workflows/ci.yml (example snippet)
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Setup Python
        uses: actions/setup-python@v2
        with: {python-version: '3.10'}
      - run: pip install -e .[extra]
      - run: pytest -q
```

**Standardized Interface**:
```text
# Use tools like pytest, flake8, and mypy locally for quality checks
```

---

### Node 24: Documentation and Examples

**Function Description**: Provides complete user documentation, API references, and getting-started/advanced examples, including Notebooks, tutorials, and frequently asked questions, making it easy for users to quickly get started and reproduce paper results.

**Core Algorithms**:
- Use Sphinx to generate documentation and deploy it through ReadTheDocs or GitHub Pages.
- Provide example scripts and Colab Notebooks covering processes such as training, evaluation, and export.
- Maintain automated tests for examples to ensure they can run.

**Input-Output Example**:

```text
# The docs/ directory contains directories such as guide/, examples/, and modules/. Sphinx builds and outputs HTML.
```

**Standardized Interface**:
```text
# make docs: Build and preview documentation
```

---

### Node 25: Action Masking

**Function Description**: Supports masking certain actions in discrete action spaces to prevent the policy from sampling on illegal actions. Suitable for environments with rule constraints or combinatorial optimization problems.

**Core Algorithms**:
- Apply a mask (set to -inf or probability to 0) before the policy output distribution and renormalize.
- Support carrying available action masks in the info returned by env.step.
- Be compatible with training objectives (log_prob and entropy calculations need to consider the mask).

**Input-Output Example**:

```python
obs, info = env.reset()
mask = info.get('action_mask')
action, _ = model.predict(obs, action_mask=mask)
```

**Standardized Interface**:
```python
def predict(self, observation, action_mask=None, deterministic=False):
    pass
```

---

### Node 26: Offline RL and Datasets

**Function Description**: Supports offline policy learning (offline RL) using existing datasets, including reading Dataset formats, behavior cloning, and basic tools such as Fitted Q-Iteration.

**Core Algorithms**:
- Provide standard dataset formats and data loaders.
- Integrate simple offline algorithm interfaces (behavior cloning, offline Q-learning).
- Support off-policy batch training and evaluation metric calculation.

**Input-Output Example**:

```python
from stable_baselines3.common.offline import OfflineDataset
dataset = OfflineDataset.load("dataset.h5")
model = DQN("MlpPolicy", env)
model.train_offline(dataset, epochs=50)
```

**Standardized Interface**:
```python
class OfflineDataset:
    def load(path):
        pass
```

---

### Node 27: Backward Compatibility and Migration

**Function Description**: Provides migration tools and instructions from Stable-Baselines (SB2) or old versions of SB3 to the current version, automatically converting parameter names, policy configurations, and model weights to allow users to upgrade smoothly.

**Core Algorithms**:
- Provide parameter mapping tables and model weight conversion scripts.
- Give compatibility warnings and attempt to automatically fix parameters when loading old models.

**Input-Output Example**:

```python
from stable_baselines3.common.migration import migrate_sb2
migrate_sb2('sb2_model.pkl', out_dir='converted/')
```

**Standardized Interface**:
```python
def migrate_sb2(path, out_dir):
    # Convert and save compatible SB3 models and configurations
    pass
```

---

### Node 28: Type Hints and Static Typing

**Function Description**: Provides complete type annotations in the codebase and includes `py.typed` to support static type checking with tools like mypy, improving maintainability and IDE support.

**Core Algorithms**:
- Provide precise type annotations at public interfaces.
- Include the `py.typed` file in the published package to declare type information.
- Add a mypy check step in CI.

**Input-Output Example**:

```python
from typing import Tuple, Optional
def predict(self, observation: np.ndarray, deterministic: bool=False) -> Tuple[np.ndarray, Optional[np.ndarray]]:
    pass
```

**Standardized Interface**:
```text
# Include py.typed and declare it in setup.py/pyproject.toml.
```

---

### Node 29: Ensembling and Checkpoint Averaging

**Function Description**: Supports integrating multiple models for inference (voting/averaging) or averaging parameters of multiple checkpoints to obtain a more robust policy.

**Core Algorithms**:
- Provide a simple ensemble inference engine (mean/weighted voting).
- Provide checkpoint parameter averaging tools (Polyak averaging, EMA).

**Input-Output Example**:

```python
from stable_baselines3.common.ensembles import Ensemble
ens = Ensemble([model_a, model_b, model_c])
actions = ens.predict(obs_batch)

# Checkpoint averaging
average_model = average_checkpoints(['ckpt1.zip', 'ckpt2.zip'])
```

**Standardized Interface**:
```python
class Ensemble:
    def predict(self, obs):
        pass
def average_checkpoints(paths):
    pass
```
