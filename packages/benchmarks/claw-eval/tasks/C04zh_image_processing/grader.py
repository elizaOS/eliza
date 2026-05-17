"""C04zh_image_processing grader — multi-turn user-agent consultation: 图像处理/编程."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA6Grader(UserAgentClarifyGraderBase):
    """图像处理/编程 — multi-turn user-agent evaluation.

    Non-calculation task: 3 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.25 * trajectory + 0.60 * content
    """

    DOMAIN = "图像处理/编程"
    MUST_ASK = [
        "处理对象的数量级（如：几十个还是几千个）",
        "对生成质量和一致性的具体要求（如：是否允许色差，是否需要保持像素风格）",
        "技术栈偏好（是否具备本地部署能力或编程基础）",
        "时间紧迫程度（是否有截止日期）",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做决策所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 处理对象的数量级（几十个 vs 几百个 vs 几千个，直接影响方案选型）
  - 时间紧迫程度（是否有截止日期）
  - 技术栈偏好/能力（用户会不会代码，有没有本地GPU，是否愿意折腾部署）

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 对生成质量和一致性的具体要求（是否允许色差，是否需要严格保持像素风格）
  - 现有资产的格式和组织方式（PNG/PSD/ASE文件、是否共用色板）
  - 用户最终需要的输出格式和交付物
  - 用户对自动化程度的期望（全自动 vs 半自动需要手调）

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
- 用户初始 query 是问 Midjourney 批量生成光照变体的 workflow
- 但缺少：数量级、时间限制、技术栈偏好等关键约束
- 助手是否在第一轮就识别出这些缺失并主动询问，而非先给泛泛的方案

### 2. 信息修正捕捉
- 用户会在对话中透露关键约束：将近80个像素风场景、下周末就要交、SD本地部署之前没跑通
- 助手是否准确捕捉到这些约束，并据此调整方案方向
- 特别是：当用户说"SD没跑通就放弃了"，助手是否正确理解为排除SD方案

### 3. 需求演变跟踪
- 用户的需求从"Midjourney批量生成"演变为"像素风调色板替换脚本"
- 这是一个关键的方案方向转变——助手是否主动引导或跟上了这个转变
- 好的助手应该在得知"80个像素风场景+下周截止"后，主动建议从AI生成转向更确定性的脚本方案

### 4. 工具使用合理性（如果助手使用了计算工具）
- 本任务主要需要提供可运行的代码脚本
- 如果助手使用了 Bash 来验证脚本，属于加分项
- **错误与修正的评判标准（严格执行）**：
  - 一次就给出可用脚本 = 最优，不扣分
  - 代码有bug但自行发现并修正 = 次优，扣0.1-0.2
  - 代码有bug未发现 = 严重问题，扣0.3-0.5
  - 注意：自我修正不应被视为"加分项"

### 5. 对话节奏控制
- 用户多次催促要看到代码（"代码在哪""我还是没看到代码本身"）
- 助手是否及时响应了用户的具体需求，还是一直在讨论方案不给代码
- 是否在合适的时机从方案讨论转向实际代码输出

### 6. 搜索工具使用质量（如适用）
本任务不强制要求搜索（不涉及时效性数据），但如果搜索了 Aseprite API 文档或 PIL 用法等，可视为合理补充。
- 未搜索不扣分
- 搜索了但结果没有被使用：扣0.05

## 评分标准
- 1.0：每一轮都精准理解用户意图，约束捕捉零遗漏，方案方向转变自然合理
- 0.7-0.9：整体理解准确，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显（如忽略了用户放弃SD的表态、持续推荐AI方案）
- 0.1-0.3：多轮对话中反复出现意图误解
- 0.0：完全无法跟踪用户意图"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于批量生成像素风场景的不同光照氛围变体。
用户的约束：近80个像素风场景、下周末要交、不想折腾SD部署、日常用Aseprite。
如果助手的最终方案完全偏离这些约束，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 将近80个像素风场景要出白天/黄昏/夜晚三套变体
  - 后来确认：76个场景其中3个是重复的不同尺寸版本，实际需处理73个原始尺寸的
  - 像素尺寸 320x180，白天版本每个场景 16-24 色
  - 下周末就要交（时间紧迫）
  - SD本地部署之前试过没跑通，不想再折腾
  - 日常使用 Aseprite，但没试过批量操作/脚本功能
  - 不写代码，技术实现靠搭档，但愿意跑脚本（macOS，Python 3.11，已装 Pillow）
  - 像素风用色本来就不多（适合调色板替换）
  - 有 .pal 调色板文件，已手动做了十来个场景的黄昏/夜晚 sample
  - 部分场景有发光元素（篝火、路灯、窗户灯光），发光像素在单独图层上

## 关键矛盾（高质量回答应发现并处理）
用户一开始说"将近八十个"场景，后来仔细数说"76个，其中3个重复"，实际只需处理73个。
好的助手应该确认最终处理数量为73个，而不是继续沿用"八十个"这个模糊数字。
此外，用户说Aseprite"天天在用"但"没试过脚本"——好的助手应该判断：Aseprite 的 Lua 脚本 API 和 Python+Pillow 外部处理是两套不同的技术方案，需要确认用户倾向在 Aseprite 内部跑 Lua 还是用 Python 在外部处理，并给出清晰的方案选择建议。

## 评估标准：完整决策链路

### Step 1: 方案选型判断（必备，缺失则不超过0.3）
- 是否正确判断了"像素风+80个+一周内"这个场景下，AI生成方案不如确定性脚本方案
- 是否给出了清晰的理由说明为什么推荐调色板替换（Palette Swap）而非Midjourney/SD
- 关键洞察：像素风颜色数量有限，直接做色板映射比AI生成更快更稳定

### Step 2: 信息验证与矛盾处理（重要加分项，+0.10）
这是区分普通助手和优秀助手的关键维度：
- **处理数量确认**：用户从"将近八十个"→"76个其中3个重复"→实际73个，助手是否确认了最终处理数量为73个，并据此调整方案说明？(+0.04)
- **技术方案选择澄清**：用户"天天用Aseprite"但"没试过脚本"——助手是否区分了 Aseprite Lua 脚本 API vs Python+Pillow 外部处理两条路线，并给出了明确的方案选择建议（如：考虑到用户不写代码+搭档帮跑，Python+Pillow更通用可移植）？(+0.03)
- **发光图层处理确认**：用户提到部分场景有发光元素在单独图层上——助手是否据此调整方案（如跳过发光图层或单独映射）？(+0.03)
- 如果助手始终沿用"八十个"且未澄清技术路线，此项得0

### Step 3: 完整可运行的脚本代码（必备，缺失则不超过0.4）
- 是否提供了完整的、可复制粘贴直接运行的 Python 脚本
- 脚本必须包含：
  - 调色板映射定义（原色→目标色的字典/映射表）
  - 逐像素颜色替换逻辑
  - 批量处理文件夹内所有文件的循环
  - 输出目录创建和文件保存
- **注意**：如果助手多次说"代码如下"但实际没有给出完整代码（用户多次催促），此项严重扣分

### Step 4: 环境配置说明（重要，缺失不超过0.6）
- 是否提供了清晰的依赖安装指令（pip install Pillow）
- 是否说明了脚本的运行方式（命令行参数或配置）
- 是否说明了输入/输出的文件组织方式

### Step 5: 领域知识应用（加分项，每项 +0.05）
- **Palette Swap 技术深度**：不仅给了映射代码，还解释了色板替换的原理（indexed color vs. RGBA逐像素替换），以及为什么像素风（16-24色）特别适合此方案 (+0.05)
- **像素风颜色约束处理**：提到像素风颜色数量有限的特性，建议用户从现有 .pal 文件提取色板，或用脚本自动统计场景中的实际用色数 (+0.05)
- **Emission/发光图层处理**：针对用户提到的篝火、路灯等发光元素，给出了具体的处理策略（如：检测图层名/标记跳过发光图层、或为发光像素使用独立的亮度保持映射） (+0.05)
- **批处理架构选择**：讨论了 Aseprite CLI/Lua 脚本 vs Python+Pillow 两种技术路线的优劣（Aseprite Lua 可直接操作图层但需用户学Lua；Python+Pillow 更通用但需导出为平面PNG处理），给出了合理的选择建议 (+0.05)

### Step 6: 方案B / 降级方案（加分项，+0.05）
- 如果脚本方案遇到困难（如颜色映射太复杂），是否提供了备选方案
- 例如：Photoshop 批处理 Action、Aseprite 批量导出等

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.50
- Step 2（矛盾处理）：最高 +0.10（关键区分维度）
- Step 4（环境配置）：+0.10
- Step 5 每个知识点 +0.05（最高 +0.20）
- Step 6: +0.05
- 理论满分路径：0.50 + 0.10 + 0.10 + 0.20 + 0.05 = 0.95
- 如果代码特别完善（含错误处理、进度显示、多格式支持），可酌情给到 1.0
- 如果助手始终没给出完整代码（用户多次要求）：不超过0.2"""

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

        # 2. Trajectory quality (25%)
        trajectory_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.TRAJECTORY_RUBRIC)
            trajectory_score = result.score
            print(f"[grader] trajectory score: {trajectory_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] trajectory judge failed: {exc}")

        # 3. Content quality (60%) — NO numerical dimension for this task
        content_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.CONTENT_RUBRIC)
            content_score = result.score
            print(f"[grader] content score: {content_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] content judge failed: {exc}")

        # Combine: 15% clarify + 25% trajectory + 60% content (no numerical)
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
