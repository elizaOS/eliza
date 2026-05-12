<p align="center">
  <img src="https://huggingface.co/datasets/xlangai/assets/resolve/main/github_banner_v2.png" alt="Banner">
</p>

<p align="center">
  <a href="https://os-world.github.io/">Website</a> •
  <a href="https://arxiv.org/abs/2404.07972">Paper</a> •
  <a href="https://timothyxxx.github.io/OSWorld/">Doc</a> •
  <a href="https://github.com/xlang-ai/OSWorld/tree/main/evaluation_examples">Data</a> •
  <a href="https://os-world.github.io/explorer.html">Data Viewer</a> •
  <a href="https://discord.gg/4Gnw7eTEZR">Discord</a> •
  <a href="https://drive.google.com/file/d/1XlEy49otYDyBlA3O9NbR0BpPfr2TXgaD/view?usp=drive_link">Cache</a>
</p>

<p align="center">
    <a href="https://img.shields.io/badge/PRs-Welcome-red">
        <img src="https://img.shields.io/badge/PRs-Welcome-red">
    </a>
    <a href="https://img.shields.io/github/last-commit/xlang-ai/OSWorld?color=green">
        <img src="https://img.shields.io/github/last-commit/xlang-ai/OSWorld?color=green">
    </a>
    <a href="https://opensource.org/licenses/Apache-2.0">
        <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg">
    </a>
    <a href="https://badge.fury.io/py/desktop-env">
        <img src="https://badge.fury.io/py/desktop-env.svg">
    </a>
    <a href="https://pepy.tech/project/desktop-env">
        <img src="https://static.pepy.tech/badge/desktop-env">
    </a>
    <br/>
</p>


## 📢 Updates
- 2025-07-28: Introducing **OSWorld-Verified**! We have made major updates, fixed several issues reported by the community, with more support for AWS (can reduce evaluation time to within 1 hour through parallelization!), and making the benchmark signals more effective. Check out more in the [report](https://xlang.ai/blog/osworld-verified). We have run new model results in the latest version and updated them on the [official website](https://os-world.github.io/). Please compare your OSWorld results with the new benchmark results when running the latest version.
- 2025-05-01: If you need pre-downloaded files for init state setup, we downloaded for you [here](https://drive.google.com/file/d/1XlEy49otYDyBlA3O9NbR0BpPfr2TXgaD/view?usp=drive_link).
- 2024-10-22: We supported Docker🐳 for hosting virtual machines on virtualized platforms. Check below for detailed instructions!
- 2024-06-15: We refactor the code of environment part to decompose VMware Integration, and start to support other platforms such as VirtualBox, AWS, Azure, etc. Hold tight!
- 2024-04-11: We released our [paper](https://arxiv.org/abs/2404.07972), [environment and benchmark](https://github.com/xlang-ai/OSWorld), and [project page](https://os-world.github.io/). Check it out!

## 💾 Installation
### VMware/VirtualBox (Desktop, Laptop, Bare Metal Machine)
Suppose you are operating on a system that has not been virtualized (e.g. your desktop, laptop, bare metal machine), meaning you are not utilizing a virtualized environment like AWS, Azure, or k8s.
If this is the case, proceed with the instructions below. However, if you are on a virtualized platform, please refer to the [Docker](https://github.com/xlang-ai/OSWorld?tab=readme-ov-file#docker-server-with-kvm-support-for-the-better) section.

1. First, clone this repository and `cd` into it. Then, install the dependencies listed in `requirements.txt`. It is recommended that you use the latest version of Conda to manage the environment, but you can also choose to manually install the dependencies. Please ensure that the version of Python is >= 3.10.
```bash
# Clone the OSWorld repository
git clone https://github.com/xlang-ai/OSWorld

# Change directory into the cloned repository
cd OSWorld

# Optional: Create a Conda environment for OSWorld
# conda create -n osworld python=3.10
# conda activate osworld

# Install required dependencies
pip install -r requirements.txt
```

Alternatively, you can install the environment without any benchmark tasks:
```bash
pip install desktop-env
```

2. Install [VMware Workstation Pro](https://www.vmware.com/products/workstation-pro/workstation-pro-evaluation.html) (for systems with Apple Chips, you should install [VMware Fusion](https://support.broadcom.com/group/ecx/productdownloads?subfamily=VMware+Fusion)) and configure the `vmrun` command.  The installation process can refer to [How to install VMware Workstation Pro](desktop_env/providers/vmware/INSTALL_VMWARE.md). Verify the successful installation by running the following:
```bash
vmrun -T ws list
```
If the installation along with the environment variable set is successful, you will see the message showing the current running virtual machines.
> **Note:** We also support using [VirtualBox](https://www.virtualbox.org/) if you have issues with VMware Pro. However, features such as parallelism and macOS on Apple chips might not be well-supported.

All set! Our setup script will automatically download the necessary virtual machines and configure the environment for you.

### Docker (Server with KVM Support for Better Performance)
If you are running on a non-bare metal server, or prefer not to use VMware and VirtualBox platforms, we recommend using our Docker support.

#### Prerequisite: Check if your machine supports KVM
We recommend running the VM with KVM support. To check if your hosting platform supports KVM, run
```
egrep -c '(vmx|svm)' /proc/cpuinfo
```
on Linux. If the return value is greater than zero, the processor should be able to support KVM.
> **Note**: macOS hosts generally do not support KVM. You are advised to use VMware if you would like to run OSWorld on macOS.

#### Install Docker
If your hosting platform supports a graphical user interface (GUI), you may refer to [Install Docker Desktop on Linux](https://docs.docker.com/desktop/install/linux/) or [Install Docker Desktop on Windows](https://docs.docker.com/desktop/install/windows-install/) based on your OS. Otherwise, you may [Install Docker Engine](https://docs.docker.com/engine/install/).

#### Running Experiments
Add the following arguments when initializing `DesktopEnv`: 
- `provider_name`: `docker`
- `os_type`: `Ubuntu` or `Windows`, depending on the OS of the VM
> **Note**: If the experiment is interrupted abnormally (e.g., by interrupting signals), there may be residual docker containers which could affect system performance over time. Please run `docker stop $(docker ps -q) && docker rm $(docker ps -a -q)` to clean up.

### AWS
Using cloud services for parallel evaluation can significantly accelerate evaluation efficiency (can reduce evaluation time to within 1 hour through parallelization!) and can even be used as infrastructure for training.
We provide comprehensive AWS support with a Host-Client architecture that enables large-scale parallel evaluation of OSWorld tasks.
For detailed setup instructions, see [Setup Guideline](SETUP_GUIDELINE.md) and [AWS Configuration Guide](https://github.com/xlang-ai/OSWorld/blob/main/desktop_env/providers/aws/AWS_GUIDELINE.md). 

### Others
We are working on supporting more 👷. Please hold tight!


## 🚀 Quick Start
Run the following minimal example to interact with the environment:

```bash
# Basic usage with default settings
python quickstart.py

# Customize provider and VM path
python quickstart.py --provider_name vmware --path_to_vm "path/to/your/vm.vmx"
```

You will see all the logs of the system running normally, including the successful creation of the environment, completion of setup, and successful execution of actions. In the end, you will observe a successful right-click on the screen, which means you are ready to go.

## 🧪 Experiments
### Agent Baselines

> **⚠️ Important Configuration Requirements:**
>
> * **Google Account Tasks**: Some tasks require Google account access and OAuth2.0 configuration. Please refer to [Setup Guideline - Google Account Setup](SETUP_GUIDELINE.md#1-google-account-setup) for detailed setup instructions.
> * **Proxy Configuration**: Some tasks may require proxy settings to function properly (this depends on the strength of website defenses against your network location). Please refer to [Setup Guideline - Proxy Configuration](SETUP_GUIDELINE.md#2-proxy-configuration).
> * **Impact of Missing Configuration**: If these configurations are not properly set up, the corresponding tasks will fail to execute correctly, leading to lower evaluation scores.


If you wish to run the baseline agent used in our paper, you can execute the following command as an example under the GPT-4o pure-screenshot setting:

Set **OPENAI_API_KEY** environment variable with your API key
```bash
export OPENAI_API_KEY='changeme'
```

Optionally, set **OPENAI_BASE_URL** to use a custom OpenAI-compatible API endpoint
```bash
export OPENAI_BASE_URL='http://your-custom-endpoint.com/v1'  # Optional: defaults to https://api.openai.com
```

Single-threaded execution (deprecated, using `vmware` provider as example)
```bash
python run.py \
    --provider_name vmware \
    --path_to_vm Ubuntu/Ubuntu.vmx \
    --headless \
    --observation_type screenshot \
    --model gpt-4o \
    --sleep_after_execution 3 \
    --max_steps 15 \
    --result_dir ./results \
    --client_password password
```

Parallel execution (example showing switching provider to `docker`)
```bash
python scripts/python/run_multienv.py \
    --provider_name docker \
    --headless \
    --observation_type screenshot \
    --model gpt-4o \
    --sleep_after_execution 3 \
    --max_steps 15 \
    --num_envs 10 \
    --client_password password
```

The results, which include screenshots, actions, and video recordings of the agent's task completion, will be saved in the `./results` (or other `result_dir` you specified) directory in this case.
You can then run the following command to obtain the result:

```bash
# Basic usage with default parameters
python show_result.py

# Specify custom parameters
python show_result.py \
    --action_space pyautogui \
    --model gpt-4o \
    --observation_type screenshot \
    --result_dir ./results

# Show detailed scores per domain (format: score/total)
python show_result.py --detailed
```

The script will display:
- Per-domain success rates
- Category-level statistics (Office, Daily, Professional)
- Overall success rate and total score
- With `--detailed` flag: compact format showing "score/total" for each domain

### Manual Task Examination
For manual verification and examination of specific benchmark tasks, you can use the manual examination tool:

```bash
python scripts/python/manual_examine.py \
    --headless \
    --observation_type screenshot \
    --result_dir ./results_human_examine \
    --test_all_meta_path evaluation_examples/test_all.json \
    --domain libreoffice_impress \
    --example_id a669ef01-ded5-4099-9ea9-25e99b569840 \
    --max_steps 3
```

This tool allows you to:
- Manually execute tasks in the environment
- Verify task correctness and evaluation metrics
- Record the execution process with screenshots and videos
- Examine specific problematic tasks

See `scripts/bash/run_manual_examine.sh` for example task IDs across different domains.

## Evaluation
### Local Evaluation
Please start by reading through the [agent interface](https://github.com/xlang-ai/OSWorld/blob/main/mm_agents/README.md) and the [environment interface](https://github.com/xlang-ai/OSWorld/blob/main/desktop_env/README.md).
Correctly implement the agent interface and import your customized version in the `run.py` (for single-threaded execution) or `scripts/python/run_multienv.py` / `scripts/python/run_multienv_xxx.py` (for parallel execution) file.
Afterward, you can execute a command similar to the one in the previous section to run the benchmark on your agent.

### Public Evaluation
If you want your results to be verified and displayed on the verified leaderboard, you need to schedule a meeting with us (current maintainer: tianbaoxiexxx@gmail.com, yuanmengqi732@gmail.com) to run your agent code on our side and have us report the results. 
You need to upload and allow us to disclose your agent implementation under the OSWorld framework (you may choose not to expose your model API to the public), along with a report that allows the public to understand what's happening behind the scenes.
Alternatively, if you are from a trusted institution, you can share your monitoring data and trajectories with us.
Please carefully follow the [Setup Guideline - Public Evaluation Platform](SETUP_GUIDELINE.md#3-public-evaluation-platform) to get results.


## ❓ FAQ
### What is the username and password for the virtual machines?
The username and password for the virtual machines are as follows (for provider `vmware`, `virtualbox` and `docker`): we set the account credentials for Ubuntu as `user` / `password`. 
For cloud service providers like `aws`, to prevent attacks due to weak passwords, we default to `osworld-public-evaluation`. 
If you make further modifications, remember to set the client_password variable and pass it to DesktopEnv and Agent (if supported) when running experiments. 
Some features like setting up proxy require the environment to have the client VM password to obtain sudo privileges, and for some OSWorld tasks, the agent needs the password to obtain sudo privileges to complete them.

### How to setup the account and credentials for Google and Google Drive?

See [Setup Guideline - Google Account Setup](SETUP_GUIDELINE.md#1-google-account-setup).

### How can I configure a proxy for the VM (if I'm behind the GFW, or I don't want some of my tasks to be identified as bot and get lower scores)?

See [Setup Guideline - Proxy Configuration](SETUP_GUIDELINE.md#2-proxy-configuration).
We also provide a pre-configured solution based on DataImpulse, please refer to the [proxy setup section](SETUP_GUIDELINE.md#23-proxy-for-specific-tasks-recommended).

### Open Source Contributors

Thanks to all the contributors!

<a href="https://github.com/xlang-ai/OSWorld/graphs/contributors">
  <img src="https://stg.contrib.rocks/image?repo=xlang-ai/OSWorld" />
</a>


## 📄 Citation
If you find this environment useful, please consider citing our work:
```
@misc{OSWorld,
      title={OSWorld: Benchmarking Multimodal Agents for Open-Ended Tasks in Real Computer Environments}, 
      author={Tianbao Xie and Danyang Zhang and Jixuan Chen and Xiaochuan Li and Siheng Zhao and Ruisheng Cao and Toh Jing Hua and Zhoujun Cheng and Dongchan Shin and Fangyu Lei and Yitao Liu and Yiheng Xu and Shuyan Zhou and Silvio Savarese and Caiming Xiong and Victor Zhong and Tao Yu},
      year={2024},
      eprint={2404.07972},
      archivePrefix={arXiv},
      primaryClass={cs.AI}
}
```

## Acknowledgement for OSWorld-Verified
Special thanks to the following institutions that provided feedback and participated in the fixes (as well as institutions that provided feedback during the process): [MoonShot AI, a.k.a. Kimi](https://www.moonshot.ai/)，[Human Data](https://www.hud.so/), [OpenAI](https://openai.com/), [ByteDance Seed TARS](https://seed-tars.com/), [Anthropic](https://www.anthropic.com/), [Simular](https://www.simular.ai/), [HKU Data Intelligence Lab](https://sites.google.com/view/chaoh)

Special thanks to the following students who participated in the specific fixes: [Mengqi Yuan](https://yuanmengqi.github.io/), [Danyang Zhang](https://zdy023.github.io/), [Xinzhuang Xiong](https://thisisxxz.com/),  [Zhennan Shen](https://scholar.google.com/citations?user=JPwg5MwAAAAJ&hl=en), [Zilong Zhou](https://github.com/adlsdztony), Yanxu Chen, [Jiaqi Deng](https://millank0817.github.io/), [Tianbao Xie](https://tianbaoxie.com/), Junda Chen, [Jixuan Chen](https://chenjix.github.io/), [Haoyuan Wu](https://www.linkedin.com/in/haoyuan-wu-240878291/).

Special thanks to the following students who participated in running the re-evaluation: [Mengqi Yuan](https://yuanmengqi.github.io/), [Zilong Zhou](https://github.com/adlsdztony), [Xinyuan Wang](https://xinyuanwangcs.github.io/), [Bowen Wang](https://bowenbryanwang.github.io/).

## You might also be interested

- **OSWorld-MCP**: Benchmarking MCP Tool Invocation in Computer-Use Agents. [Website](https://osworld-mcp.github.io/)
