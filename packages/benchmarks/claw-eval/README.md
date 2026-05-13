<div align="center">

<img src="claw_eval.png" width="160" alt="Claw-Eval Logo">

# Claw-Eval

[![Tasks](https://img.shields.io/badge/tasks-300-blue)](#tasks)
[![Models](https://img.shields.io/badge/models-14-green)](#leaderboard)
[![Paper](https://img.shields.io/badge/paper-arXiv-red)](https://arxiv.org/abs/2604.06132v1)
[![Leaderboard](https://img.shields.io/badge/leaderboard-live-purple)](https://claw-eval.github.io)
[![Dataset](https://img.shields.io/badge/🤗-Dataset-yellow)](https://huggingface.co/datasets/claw-eval/Claw-Eval)
[![Dataset](https://img.shields.io/badge/ModelScope-MyRepo-624aff?logo=modelscope)](https://modelscope.cn/datasets/claw-eval/Claw-Eval)
[![License](https://img.shields.io/badge/license-MIT-orange)](LICENSE)

> Claw-Eval: Towards Trustworthy Evaluation of Autonomous Agents. <br>
> 300 human-verified tasks | 2,159 rubrics | 9 categories | Completion · Safety · Robustness.

</div>


---

## Leaderboard

Browse the full leaderboard and individual task cases at **[claw-eval.github.io](https://claw-eval.github.io)**.

**Evaluation Logic (Updated March 2026):**

* **Primary Metric: Pass^3.** To eliminate "lucky runs," a model must now consistently pass a task across **three independent trials** ($N=3$) to earn a success credit.
* **Strict Pass Criterion:** Under the Pass^3 methodology, a task is only marked as passed if the model meets the success criteria in **all three runs**.
* **Reproducibility:** We are committed to end-to-end reproducibility. Our codebase is currently being audited to ensure **all benchmark results on the leaderboard can be verified by the community**.
* **Handling API Instability**: In the event of execution errors caused by network or API fluctuations, we manually re-trigger the evaluation to ensure exactly **3** trajectories are successfully generated.

## Get Involved

We sincerely thank the teams behind [Meta (Muse Spark)](https://x.com/alexandr_wang/status/2045348588734066794?s=20), [KAT-Coder-V2](https://arxiv.org/abs/2603.27703), [Kimi](https://www.kimi.com/blog/kimi-k2-6), [Qwen](https://qwen.ai/blog?id=qwen3.6), [Tencent Hunyuan](https://github.com/Tencent-Hunyuan/Hy3-preview), [Xiaomi MiMo](https://mimo.xiaomi.com/mimo-v2-5-pro), [Z.AI / GLM](https://docs.z.ai/guides/vlm/glm-5v-turbo#pure-text-coding-tasks) and [Ant Ling](https://x.com/AntLingAGI/status/2046661013639209113) for publicly referencing, evaluating on, and engaging with Claw-Eval. We are grateful for this recognition, and we hope Claw-Eval can help the community jointly build a more scientific foundation for evaluating the general agentic capabilities of foundation models.

To run Claw-Eval and submit results to join the leaderboard, contact: **bwye@stu.pku.edu.cn**, **lirang410@gmail.com**, **nlp.lilei@gmail.com**.

## 📢 Updates
* **v1.1.0** — 300 human-verified tasks in 9 categories: Agents perceive, reason, create, and deliver.

* **v1.0.0** — Built on reproducible real-world complexity.
* **v0.0.0** — From chatbot to real world. (2026.3)



## Tasks

300 tasks across 3 splits and 9 categories, each task with human-verified rubrics.

| Split | Count | Description |
|-------|-------|-------------|
| `general` | 161 | Core agent tasks across communication, finance, ops, productivity, etc. |
| `multimodal` | 101 | Perception and creation — webpage generation, video QA, document extraction, etc. |
| `multi_turn` | 38 | Conversational tasks with simulated user personas for clarification and advice |

Agents are graded on three dimensions through full-trajectory auditing:
- **Completion** — did the agent finish the task?
- **Safety** — did it avoid harmful or unauthorized actions?
- **Robustness** — does it pass consistently across multiple trials?

### Dataset

Available on Hugging Face: [claw-eval/Claw-Eval](https://huggingface.co/datasets/claw-eval/Claw-Eval)

| Field | Type | Description |
|-------|------|-------------|
| `task_id` | string | Unique task identifier |
| `query` | string | Task instruction / description |
| `fixture` | list[string] | Fixture files required (available in `data/fixtures.tar.gz`) |
| `language` | string | `en` or `zh` |
| `category` | string | Task domain |

---

## Quick Start

We recommend using [uv](https://docs.astral.sh/uv/) for fast, reliable dependency management:

```bash
pip install uv
uv venv --python 3.11
source .venv/bin/activate
```

Prepare your keys and set up the environments with one command:

```bash
export OPENROUTER_API_KEY=sk-or-...
export SERP_DEV_KEY=... # add this for tasks need real web search.  You can get api key from https://www.novada.com for convenience.
bash scripts/test_sandbox.sh
```

> **Note on video fixtures:** Due to file size limits, this GitHub repository does not include video files for video-related tasks. The complete fixtures (including all videos) are available on Hugging Face: [claw-eval/Claw-Eval](https://huggingface.co/datasets/claw-eval/Claw-Eval).

> **Note on grade:** we use **gemini-3-flash** in general and multimodal tasks while **claude opus4.6** for both grader and user-agent in multi_turn tasks!

Go rock 🚀

```bash
claw-eval batch --config model_configs/claude_opus_46.yaml --sandbox --trials 3 --parallel 16
# For different tasks, you can follow different config: config_general.yaml/config_multimodal.yaml/config_user_agent.yaml.
```

---

## Roadmap

- [x] More real-world, multimodal tasks in complex productivity environments
- [x] Comprehensive, fine-grained scoring logic with deep state verification
- [x] Enhanced sandbox isolation and full-trace tracking for transparent, scalable evaluation


## Contribution
We welcome any kind of contribution. Let us know if you have any suggestions!

## Acknowledgements
Our test cases are built on the work of the community. We draw from and adapt tasks contributed by OpenClaw, PinchBench, OfficeQA, OneMillion-Bench, Finance Agent, and Terminal-Bench 2.0.

## Core Contributors
[Bowen Ye](https://github.com/pkuYmiracle)(PKU), [Rang Li](https://github.com/lirang04) (PKU), [Qibin Yang](https://github.com/yangqibin-caibi) (PKU), [Zhihui Xie](https://zhxie.site/)(HKU), [Yuanxin Liu](https://llyx97.github.io/)(PKU), [Linli Yao](https://yaolinli.github.io/)(PKU), [Hanglong Lyu](https://github.com/Albus2002)(PKU), [Lei Li](lilei-nlp.github.io)(HKU, project lead)


## Advisors
[Tong Yang](https://yangtonghome.github.io/) (PKU), [Zhifang Sui](https://cs.pku.edu.cn/info/1226/2014.htm) (PKU), [Lingpeng Kong](https://ikekonglp.github.io/) (HKU), [Qi Liu](https://leuchine.github.io/) (HKU)

## Citation

If you use Claw-Eval in your research, please cite:

```bibtex
@misc{ye2026clawevaltrustworthyevaluationautonomous,
      title={Claw-Eval: Towards Trustworthy Evaluation of Autonomous Agents}, 
      author={Bowen Ye and Rang Li and Qibin Yang and Yuanxin Liu and Linli Yao and Hanglong Lv and Zhihui Xie and Chenxin An and Lei Li and Lingpeng Kong and Qi Liu and Zhifang Sui and Tong Yang},
      year={2026},
      eprint={2604.06132},
      archivePrefix={arXiv},
      primaryClass={cs.AI},
      url={https://arxiv.org/abs/2604.06132}, 
}
```

## License

This project is released under the [MIT License](LICENSE).

