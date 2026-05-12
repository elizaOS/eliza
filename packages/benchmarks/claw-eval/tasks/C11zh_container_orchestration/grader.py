"""C11zh_container_orchestration grader — multi-turn user-agent consultation: 容器编排."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA14Grader(UserAgentClarifyGraderBase):
    """容器编排 — multi-turn user-agent evaluation.

    Scoring: 3 independent judge calls, code-weighted (no numerical dimension):
      completion = 0.15 * clarify + 0.25 * trajectory + 0.60 * content
    """

    DOMAIN = "容器编排"
    MUST_ASK = [
        "GPU 的具体型号（如 A100, 4090 等，涉及 MIG 或驱动支持差异）",
        "是否需要进行显存层面的硬限制（如 MIG 切分或应用层限制）",
        "部署的机器规模与场景（如多台机器、多课题组隔离需求）",
        "是否需要完整的项目文件结构模板",
]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了设计完整方案所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - GPU 的具体型号（不同型号的隔离策略完全不同）
  - 部署的场景和规模（单机多卡 vs 多机多卡、是否需要隔离）

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 是否需要显存层面的硬限制（MIG 切分或应用层限制）
  - 是否需要完整的可运行配置文件（而非仅语法片段）
  - nvidia-container-toolkit 是否已安装、Docker Compose 版本
  - 各服务的显存实际用量（影响MIG profile选择）
  - 网络隔离或存储卷隔离需求

评分标准：
- 1.0：基础信息全部收集 + 主动追问了2项以上深入信息
- 0.8-0.9：基础信息全部收集 + 追问了1项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始 query 只问了 deploy.resources 写法，但实际需求远比语法片段复杂
- 助手是否在给出基础语法后主动追问硬件环境和实际场景

### 2. 信息修正捕捉
- 用户在对话中逐步透露信息（A100+4090混合、MIG需求、三个课题组）
- 助手是否准确捕捉到每轮新增的约束条件，并不断更新方案

### 3. 需求演变跟踪
- 用户需求从"语法查询"演变为"显存限制"再到"完整的跨机器多硬件GPU隔离方案"
- 注意用户会明确要求"完整的文件内容"而非仅目录结构
- 助手是否跟上了需求的自然升级

### 4. 工具使用合理性（如果助手使用了工具）
- 是否在需要验证配置语法时调用sandbox执行
- **错误与修正的评判标准（严格执行）**：
  - 一次就给出正确配置 = 最优，不扣分
  - 配置有误但能自行发现并修正 = 次优，扣0.1-0.2
  - 给出了过时或错误的语法（如 runtime: nvidia）且未意识到 = 扣0.3-0.5

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性方案，而非一直追问不给配置
- 用户追问"完整文件内容"时，是否直接给出而非推脱或仅给目录
- 注意用户是重度技术用户，习惯得到可直接执行的方案

### 6. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务涉及技术细节（Docker Compose GPU配置、MIG设置、nvidia-container-toolkit），这些规范更新频繁。

**搜索必要性判断：**
- Docker Compose 的 GPU 资源配置语法——新旧写法差异大，是否验证了当前推荐写法？
- MIG 配置命令——是否搜索了A100 MIG的最新操作步骤？
- 如果助手完全没搜索就给出了配置文件，需要考虑语法可能过时

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键技术文档
- 良好(扣0.05)：搜索了但查询不够精准
- 一般(扣0.1)：过度搜索或重复搜索
- 较差(扣0.15)：搜索结果没有被正确使用
- 未搜索(扣0.1)：完全没搜索，但如果配置语法恰好正确，可减轻至0.05

## 评分标准
- 1.0：每一轮都精准理解用户意图，需求升级完美响应，交付物完整可用
- 0.7-0.9：整体理解准确，交付物基本完整，偶有一轮不够精准
- 0.4-0.6：部分轮次理解偏差（如给了目录结构而非文件内容），或配置语法过时
- 0.1-0.3：多轮对话中反复出现意图误解
- 0.0：完全无法跟踪用户意图"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。关注回答的技术准确性、完整性、可执行性。

## 话题一致性（前置检查）
原始问题是关于「Docker Compose GPU资源限制 + 指定显卡配置」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - GPU型号：A100 80G（两台）和 4090 24G（两台）混合环境
  - 显存限制策略：A100 使用 MIG (3g.40gb x 2 per card)，4090 使用应用层限制
  - 场景：三个课题组各跑一个推理服务（vLLM serving + 7B模型）
  - 其中一个课题组的13B模型需要tensor parallel=2，至少需要完整80G
  - Docker 24.x，NVIDIA Container Toolkit已装，CUDA 12.2，驱动535.x
  - 交付物：完整的 docker-compose.yml（必须是文件内容，不能只是目录结构）
  - 需要挂载宿主机/data/models目录作为只读volume

## 评估标准：完整决策链路（7个步骤）

### Step 1: 基础语法正确（必备，缺失则不超过0.3）
- docker-compose.yml 使用新版 Compose Spec 语法（deploy.resources.reservations.devices）
- 不使用已废弃的 `runtime: nvidia` 写法
- 配置语法可以直接运行（无语法错误）

### Step 2: 信息验证与矛盾处理（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **MIG instance数量与课题组数量不匹配**：两台A100各切两个3g.40gb = 4个MIG instances，但只有三个课题组——第四个instance空着？好的助手应主动注意到这个数量不匹配，询问分配方案。而且后续用户会透露其中一个课题组的13B模型需要tensor parallel=2，至少需要完整80G，意味着有一台A100不能切MIG得留整卡。好的助手应帮用户理清这个矛盾并调整方案 (+0.05)
- **4090隔离方案选择**：用户说"4090只能靠应用层限了"，但具体方案有多种——CUDA_MPS、CUDA_VISIBLE_DEVICES、还是在vLLM层面设gpu_memory_utilization参数。三种方案隔离程度不同（MPS是进程级时间片共享，CUDA_VISIBLE_DEVICES是设备级独占，gpu_memory_utilization是应用层软限制）。好的助手应主动区分并推荐最合适的方案 (+0.05)
- **Tensor parallel需要整卡**：tensor parallel=2跨多个MIG instance是不支持的（MIG instances互相隔离），需要完整GPU。好的助手应指出这一点而非尝试在MIG环境下配置tensor parallel (+0.05)
- 如果助手完全没有识别以上矛盾，只给出通用配置模板，此项得0

### Step 3: 硬件差异化方案（必备，缺失则不超过0.5）
- A100 MIG配置：正确说明MIG启用步骤、profile选择、UUID指定方式
- 4090 应用层限制：给出具体的应用层显存限制方案
- 差异对比：明确区分硬件级隔离（MIG）和软限制的区别

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **MIG profile规格**：准确解释3g.40gb的含义（3个GPC + 40GB显存），说明A100 80G可选的其他MIG profile（如1g.10gb、2g.20gb、4g.40gb、7g.80gb等）及各自适用场景 (+0.04)
- **4090不支持MIG的替代方案**：系统性说明三种替代方案（CUDA_MPS进程级共享、CUDA_VISIBLE_DEVICES设备级独占、gpu_memory_utilization应用层限制）的优劣对比，而非只给一种 (+0.04)
- **Tensor parallel需整卡**：明确说明tensor parallel不能跨MIG instance运行，需要整卡（non-MIG模式），并据此调整A100的MIG分配方案 (+0.04)
- **Docker Compose GPU配置语法**：完整展示deploy.resources.reservations.devices的正确写法，包括driver、count、device_ids、capabilities等字段的正确用法 (+0.04)

### Step 5: 完整配置文件交付（加分项，+0.05）
- A100 compose文件：完整的docker-compose.yml内容（不是片段）
- 4090 compose文件：完整的docker-compose.yml内容
- 如果只给了目录结构或代码片段而非完整文件，此项得0

### Step 6: 可操作建议与注意事项（加分项，+0.04）
- 给出MIG启用的完整命令序列
- 提到Docker Compose版本要求、nvidia-container-toolkit安装前提等
- 使用结构化格式，方便用户直接参照执行

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（信息验证与矛盾处理）：最高 +0.15（这是拉开差距的关键维度）
- Step 4 每个知识点 +0.04（最高 +0.16）
- Step 5: +0.05
- Step 6: +0.04
- 理论满分路径：0.5 + 0.15 + 0.16 + 0.05 + 0.04 = 0.90
- 如果配置特别完善（如包含了健康检查、日志配置、restart policy等高级特性），可酌情给到 1.0"""

    # Keep FINAL_ANSWER_RUBRIC empty so base class won't make its own call
    FINAL_ANSWER_RUBRIC = ""

    def grade(self, messages, dispatches, task, audit_data=None, judge=None,
              media_events=None, env_snapshot=None):
        from claw_eval.models.trace import DimensionScores

        scores = DimensionScores()
        scores.safety = 1.0
        scores.robustness = 1.0

        if judge is None:
            return scores

        full_conversation = self.format_conversation_detailed(
            messages, include_tool_use=True, include_tool_result=True,
        )
        clarify_conversation, _ = self._split_phases(messages)
        prompt_text = task.prompt.text

        # 1. Clarification quality (15%)
        clarify_score = 0.0
        if self.CLARIFICATION_RUBRIC and clarify_conversation:
            try:
                result = judge.evaluate(prompt_text, clarify_conversation, "",
                                        self.CLARIFICATION_RUBRIC)
                clarify_score = result.score
                print(f"[grader] clarification score: {clarify_score:.2f} — {result.reasoning[:200]}")
            except Exception as exc:
                print(f"[grader] clarification judge failed: {exc}")

        # 2. Trajectory quality (25%) — full conversation intent understanding
        trajectory_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.TRAJECTORY_RUBRIC)
            trajectory_score = result.score
            print(f"[grader] trajectory score: {trajectory_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] trajectory judge failed: {exc}")

        # 3. Content quality (60%)
        content_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.CONTENT_RUBRIC)
            content_score = result.score
            print(f"[grader] content score: {content_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] content judge failed: {exc}")

        # Combine: 15% clarify + 25% trajectory + 60% content
        scores.completion = round(
            0.15 * clarify_score +
            0.25 * trajectory_score +
            0.60 * content_score,
            4
        )
        print(f"[grader] completion: {scores.completion:.4f} "
              f"(clarify={clarify_score:.2f}*0.15 + trajectory={trajectory_score:.2f}*0.25 "
              f"+ content={content_score:.2f}*0.60)")

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
