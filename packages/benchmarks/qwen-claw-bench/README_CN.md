<div align="center">

<img src="imgs/qwen-capybara.png" width="400" alt="QwenClawBench Logo">

# QwenClawBench

> **面向 OpenClaw 智能体的真实用户场景评测基准 — 为大规模可靠评测而生**

[English](README.md) | 中文

<img src="imgs/qwen-logo.png" height="55" alt="Qwen Logo">
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
<img src="imgs/alibaba-data-logo.png" height="50" alt="AlibabaData Logo">


<br>

[![排行榜](https://img.shields.io/badge/排行榜-查看-blue)](https://skylenage-ai.github.io/QwenClawBench-Leaderboard/)
[![HuggingFace](https://img.shields.io/badge/HuggingFace-数据集-yellow)](https://huggingface.co/datasets/skylenage-ai/QwenClawBench)
[![许可证](https://img.shields.io/badge/许可证-MIT-green)](LICENSE)
[![任务数](https://img.shields.io/badge/任务数-100-orange)](#任务)
[![版本](https://img.shields.io/badge/版本-1.1-purple)](#未来计划)

</div>


QwenClawBench 是一个面向 [OpenClaw](https://github.com/openclaw/openclaw) 智能体的真实用户场景评测基准，最初在 [Qwen3.6-Plus](https://qwen.ai/blog?id=qwen3.6) 的研发过程中作为内部基准构建，现已优化并开源。

## 为什么选择 QwenClawBench？

QwenClawBench 包含覆盖 **8 个核心领域**的 **100 道任务**，每道任务均配备独立的模拟工作区。领域精心选取以反映用户真实的 OpenClaw 使用场景，资产文件则用于模拟真实工作环境。

在 OpenClaw 上复现大规模评测并非易事，结果高度依赖基础设施的稳定性。为此，我们内置了以下特性：

- **Docker 隔离**：每道任务在独立的 Docker 容器中运行，确保环境一致性与可复现性
- **并发执行**：任务跨多个容器并行运行，大幅缩短总评测耗时
- **异常检测**：基础设施故障（API 错误、容器崩溃、超时）被显式标记，而非静默地计入平均分，让你随时清楚哪些结果可信
- **断点续跑**：中断的评测可从断点恢复，跳过已完成的健康任务，确保稳定的最终结果

## 快速开始

### 环境要求

- Python >= 3.10
- Docker

**安装依赖：**
```bash
pip install pyyaml>=6.0.1 tqdm>=4.0
```

**拉取 OpenClaw Docker 镜像：**
```bash
docker pull ghcr.io/openclaw/openclaw:main
```

### 配置

1. 将评测数据放置到 `data/<dataset_name>/` 目录下（默认为 `qwenclawbench-v1.1-100`），确保以下结构：

```
data/qwenclawbench-v1.1-100/
├── tasks/       # task_*.md 文件
└── assets/      # 各任务的资产目录
```

2. 在 `openclaw_config/openclaw.json` 中配置模型提供商。可参考 `openclaw_config/openclaw.json.example`，或直接复制已有的 `~/.openclaw/openclaw.json`。

3. 在 `openclaw_config/.env` 中配置 API 凭证。参见 `openclaw_config/.env.example`，其中必填变量已标注。

### 运行评测

```bash
# 设置变量
DATASET="qwenclawbench-v1.1-100"
RUNS=3
CONCURRENCY=10
LOGDIR="logs/$DATASET"

# 启动评测：10 个容器并行，每题跑 3 次取平均
./scripts/run.sh --model dashscope/qwen3.6-plus \
    --dataset $DATASET \
    --runs $RUNS \
    --concurrency $CONCURRENCY \
    --output-dir ./results/$DATASET/qwen3.6-plus \
    --log-file $LOGDIR/qwen-3.6-plus.log
```

中断的评测可直接续跑，无需重新执行已完成的任务，也可对异常任务进行选择性重试：

```bash
# 续跑中断的评测 — 使用与原始运行相同的 --output-dir
./scripts/run.sh --model dashscope/qwen3.6-plus \
    --dataset $DATASET \
    --runs $RUNS \
    --concurrency $CONCURRENCY \
    --output-dir ./results/$DATASET/qwen3.6-plus \
    --log-file $LOGDIR/qwen-3.6-plus.log

# 续跑并重新执行所有异常任务
./scripts/run.sh --model dashscope/qwen3.6-plus \
    --dataset $DATASET \
    --runs $RUNS \
    --concurrency $CONCURRENCY \
    --output-dir ./results/$DATASET/qwen3.6-plus \
    --log-file $LOGDIR/qwen-3.6-plus.log \
    --rerun-anomalous

# 强制全新运行，丢弃已有结果
./scripts/run.sh --model dashscope/qwen3.6-plus \
    --dataset $DATASET \
    --runs $RUNS \
    --concurrency $CONCURRENCY \
    --output-dir ./results/$DATASET/qwen3.6-plus \
    --log-file $LOGDIR/qwen-3.6-plus.log \
    --no-resume
```

## 任务

### 任务类别分布

QwenClawBench 在任务设计上注重**真实性**与**复杂性**，涵盖 8 个领域的 100 道任务。

| 类别 | 题数 | 描述 |
|------|------|------|
| Workflow and Agent Orchestration | 21 | 工作流编排、技能创建、定时任务、多智能体协同 |
| System Operations and Administration | 20 | 系统运维、环境配置、故障排查、工作区管理 |
| Knowledge and Memory Management | 15 | 知识库构建、记忆系统设计、文档管理、上下文检索 |
| Finance and Quantitative Trading | 10 | 量化策略回测、套利监控、交易分析、持仓管理 |
| Data Analysis and Modeling | 10 | 统计分析、数据处理、质量审计、回归建模 |
| Security and Vulnerability Management | 9 | 安全审计、凭证管理、注入防御、隐私合规 |
| Communication and Scheduling | 8 | 消息通知、日程规划、定时提醒、任务调度 |
| Research and Information Retrieval | 7 | 竞品分析、文献检索、技术研究、SEO 关键词研究 |

### 任务结构

每道任务是一个 Markdown 文件（`data/tasks/task_*.md`），包含 **YAML frontmatter** 头部和结构化的**正文分节**。

**Frontmatter 元数据：**

| 字段 | 说明 |
|------|------|
| `id` | 任务唯一标识符 |
| `name` | 任务短标题 |
| `category` / `subcategory` | 任务类别与细分类 |
| `grading_type` | 评分模式：`automated`（纯自动化）、`llm_judge`（纯 LLM 评审）、`hybrid`（混合） |
| `grading_weights` | hybrid 模式下自动化与 LLM 评审的权重分配 |
| `timeout_seconds` | 任务执行超时时间 |
| `workspace_files` | 任务初始工作区文件映射 |

**正文分节：**

| 章节 | 内容 |
|------|------|
| `## Prompt` | 给智能体的用户指令——智能体需要完成的具体任务 |
| `## Expected Behavior` | 期望行为的详细描述，同时作为 LLM 评审的参考上下文 |
| `## Grading Criteria` | 评分要点清单（`- [ ]` 格式） |
| `## Automated Checks` | 自动化评分代码（Python），定义 `grade(transcript, workspace_path) -> dict` 函数 |
| `## LLM Judge Rubric` | LLM 评审维度及各分数档位的详细说明 |

**资产目录：**

每道任务在 `data/assets/<task_id>/` 下有一个对应目录，包含初始工作区文件（代码、配置、数据、日志等）。任务执行前，这些文件会被复制到 Docker 容器的工作区中。

## 评分机制

QwenClawBench 支持三种评分模式：`automated`、`llm_judge` 和 `hybrid`。

**Automated（自动化评分）：**
任务定义中嵌入 Python 函数 `grade(transcript, workspace_path)`，对智能体的交付物进行确定性的规则检查——验证输出文件、命令结果和工作区状态。最终分数为各检查维度的平均值。

**LLM Judge（LLM 评审）：**
评审模型（默认 claude-opus-4.5）根据 rubric 对智能体的操作轨迹进行多维度评分，每个维度 0.0 到 1.0，最终加权平均。

**Hybrid（混合评分）：**

两种方式独立运行后按 `grading_weights` 合并。两者设计上互补：自动化检查针对具体交付物做基于规则的基准核查，LLM 评审则评估智能体推理轨迹的质量与连贯性。

然而在实践中，我们发现部分任务中智能体未能给出正确的交付物，却在 LLM 评审中仍获得高分。这是因为 LLM 评审主要关注轨迹质量，稳定性相对较差——也更容易被能够输出流畅但错误内容的智能体所"欺骗"。为此，我们默认采用**惩罚式评分**：

$$
\text{score} = w_\text{auto} \cdot s_\text{auto} + w_\text{llm} \cdot s_\text{llm} \cdot \mathbb{1}[s_\text{auto} \geq 0.75]
$$

当自动化分数低于 0.75 时，LLM 评审贡献直接归零——认为一个连基本交付物检查都无法通过的模型，无论推理过程多好，都不应从评审中获得额外分数。可通过 `--simple-scoring` 切换为简单加权平均。

## 项目结构

```
QwenClawBench/
├── README.md
├── README_CN.md
├── scripts/
│   ├── benchmark.py          # 评测主入口
│   ├── lib_tasks.py          # 任务加载与解析
│   ├── lib_grading.py        # 评分引擎（自动化 + LLM 评审 + 混合）
│   ├── lib_docker.py         # Docker 容器管理
│   ├── lib_agent.py          # OpenClaw 智能体交互
│   ├── lib_anomalies.py      # 异常检测
│   └── run.sh                # 快捷运行脚本
├── openclaw_config/
│   ├── openclaw.json         # OpenClaw 模型与提供商配置
│   └── .env                  # API 凭证（不应提交到版本库）
└── data/
    └── <dataset>/
        ├── tasks/            # 100 个 task_*.md 任务定义文件
        └── assets/           # 100 个任务资产目录（初始工作区文件）
```

## 未来计划

我们将持续维护本仓库和排行榜，并计划在后续版本中扩展以下内容：

- 需要复杂记忆与技能链式调用的长期任务
- 更广泛的生产力工作流场景覆盖
- 探索更合理的打分机制，以更准确地衡量模型在真实场景中的实用价值
- 更丰富的真实世界环境（模拟服务器、复杂文件系统等）
- 模拟用户交互

## 致谢

QwenClawBench 基于 [PinchBench](https://github.com/pinchbench/skill) 框架构建。我们也向社区的其他开源贡献致谢，包括 [Claw-Eval](https://github.com/claw-eval/claw-eval)、[ZClawBench](https://huggingface.co/datasets/zai-org/ZClawBench) 和 [WildClawBench](https://github.com/InternLM/WildClawBench) 等。

## 引用

如果您在研究中使用了 QwenClawBench，请引用：

```bibtex
@misc{qwenclawbench1.1,
    title = {{QwenClawBench}: Real-user-distribution benchmark for OpenClaw agents},
    url = {github.com/SKYLENAGE-AI/QwenClawBench},
    author = {{Qwen Team} and {Alibaba Data}},
    month = {April},
    year = {2026}
}
```

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
