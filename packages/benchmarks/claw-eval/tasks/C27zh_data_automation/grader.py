"""C27zh_data_automation grader — multi-turn user-agent consultation: 数据自动化.

Scoring: 4 independent judge calls, code-weighted:
  completion = 0.15 * clarify + 0.20 * trajectory + 0.25 * numerical + 0.40 * content
"""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA215Grader(UserAgentClarifyGraderBase):
    """数据自动化 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.25 * numerical + 0.40 * content
    """

    DOMAIN = "数据自动化"
    MUST_ASK = [
        "下辖派出所数量",
        "各派出所上报的Excel格式是否统一、列名具体有哪些",
        "数据来源是什么系统，是手动导出还是有接口",
        "汇总后的日报需要输出什么样的格式和内容",
        "技术环境和权限情况（能否安装Python等工具、网络限制）",
        "当前手动汇总的具体痛点",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做方案所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 派出所数量（14个）
  - Excel列名和格式统一情况
  - 数据来源流程（警综平台手动导出）
  - 用户技术水平（不会写代码，能跑现成脚本）
  - 操作系统和已有软件环境

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 日报输出格式要求（Excel总表 + Word简报）
  - 目前手动汇总的具体痛点（列名不统一、个别所改列名或加列）
  - 每天的截止时间和工作流程
  - 数据量规模（每所每天多少条）
  - 历史数据情况（是否需要回溯处理）

## 高级信息（深度追问才能获得）
  - 网络环境限制（不能上外网，装软件需审批）
  - 数据敏感性要求（不能传外部云平台）
  - 数据质量问题（接警总数与分类之和不一致）
  - 用户已有的VBA经验和遇到的问题

评分标准：
- 1.0：基础信息全部收集 + 追问到高级信息中的2项以上
- 0.8-0.9：基础信息全部收集 + 追问到深入信息2项以上
- 0.7：基础信息全部收集，但未追问深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接基于不完整信息给方案
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始query只说了"想搞自动化"，缺少格式细节、技术环境、输出要求等
- 助手是否在前几轮就识别出这些缺失并系统地询问，而非先给泛泛方案再补问

### 2. 需求理解深度
- 用户本质需求不只是"合并Excel"，还包括：列名容错、数据校验、生成Word简报、适配离线环境
- 助手是否逐步挖掘出了这些深层需求，还是停留在表面的"给你个Python脚本"

### 3. 需求演变跟踪
- 用户可能从"自动汇总"扩展到"趋势分析""数据质量检查"等
- 助手是否跟上了需求的自然演变

### 4. 工具使用合理性（如果助手使用了工具）
- **计算工具**：是否用sandbox验证了脚本能正确运行，而非直接给未经测试的代码
  - 一次通过 = 最优
  - 调用出错但自行修正 = 次优，扣0.1-0.2
  - 给出无法运行的代码且未发现 = 扣0.3-0.5
- **搜索工具**：是否搜索了公安数据自动化的最新实践、Python离线安装方法、python-docx等库的用法等相关信息
  - 精准搜索(1-3次) = 最优
  - 过度搜索(6+次) = 扣分
  - 完全不搜索但给出的方案合理 = 轻微扣分(0.05)

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性方案，而非一直追问不给答案
- 面对用户提出的新问题（如数据不一致），是否及时回应

## 评分标准
- 1.0：每一轮都精准理解用户意图，需求演变完美跟踪，工具使用高效恰当
- 0.7-0.9：整体理解准确，工具使用基本合理，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显（如忽略了网络限制、数据敏感性等约束），或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手给出的脚本/方案的技术准确性（0.0-1.0）。不要考虑内容全面性或建议好坏，只关注技术实现是否正确。

## 话题一致性（前置检查）
原始问题是关于「公安派出所接处警数据Excel自动汇总生成日报」。
如果助手的最终回答完全偏离了这个主题，技术准确性直接判0。

## 用户提供的关键技术参数
  - 14个派出所，每所每天上报1行汇总数据
  - 12个标准列名：报送单位、日期、接警总数、刑事警情、治安警情、交通警情、火灾警情、其他警情、出动警力、处结数、未处结数、备注
  - 列名不统一问题：有所把"接警总数"写成"总接警数"或"接警量"，有的多加一列"出警时间"
  - 需要输出：Excel汇总总表（含合计行）+ Word简报
  - 环境：Windows 10 + WPS，无外网，需离线安装Python

## 技术正确性检查项

| 检查项 | 正确实现 | 常见错误 |
|--------|----------|----------|
| 标准列名数量 | 恰好12列 | 多了或少了列 |
| 列名模糊匹配/映射 | 有ALIAS字典或正则映射处理变体列名 | 只做精确匹配，遇到变体报错 |
| 多余列处理 | 识别并剔除/忽略非标准列（如"出警时间"） | 多余列导致合并失败 |
| 数据校验逻辑 | 接警总数 == 刑事+治安+交通+火灾+其他 | 无校验或校验公式错误 |
| 合计行生成 | 数值列求和，报送单位列写"合计" | 把非数值列也求和导致报错 |
| 文件编码处理 | 处理了GBK/UTF-8编码问题 | 中文文件名或内容乱码 |
| 依赖库选择 | pandas + openpyxl（或xlrd），python-docx | 用了需要外网的库或不兼容WPS的库 |
| 脚本可运行性 | 完整可运行，含import和主入口 | 伪代码或片段，缺少关键部分 |

## 数值校验（如果助手给出了数据校验相关的示例）
- 接警总数45 vs 分类之和38 → 差异7条，助手是否能正确计算这个差异
- 14个所 × 1行 = 14行数据 + 1行合计 = 15行总表

## 评分规则（严格执行）
- 1.0：脚本完整可运行，包含列名映射、多余列处理、数据校验、合计行，技术细节全部正确
- 0.7-0.9：脚本基本可运行，核心功能正确，但缺少列名映射或数据校验中的一项
- 0.4-0.6：给出了脚本框架，但有明显技术错误（如列名写错、逻辑bug）或关键功能缺失
- 0.2-0.3：只给了伪代码或思路描述，没有可运行脚本
- 0.0-0.1：脚本完全无法运行或与任务无关"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑脚本是否能运行，只关注方案的完整性、专业性、实用性和领域知识深度。

## 话题一致性（前置检查）
原始问题是关于「公安派出所接处警数据Excel自动汇总生成日报」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 14个派出所，每所每天4点前通过企业微信发Excel
  - 12个标准列名，但有2-3个所经常改列名或加列
  - 警综平台手动导出 → Excel → 企业微信群发 → 办公室手动汇总
  - Windows 10，有WPS无Python，不能上外网，装软件需信息科审批3-5天
  - 数据不涉密但有保密要求，不能传外部云平台
  - 有个所的接警总数与分类之和不一致（45 vs 38，差7条）
  - 用户以前用VBA合并过但没做列名校验
  - 领导还想做趋势分析

## 关键矛盾（高质量回答应发现并分析）
用户提供的信息中存在数据质量矛盾：
  - 某所上报的"接警总数"为45，但刑事+治安+交通+火灾+其他警情加起来只有38
  - 差额7条的可能原因：①分类遗漏（有警情未归入五大类）②录入错误③警综平台导出时的统计口径差异（如接警≠出警，部分接警经甄别后未立案也未归入任何分类）
  - 好的助手应该主动分析这个差异的可能原因，并在脚本中加入校验逻辑和异常标记

## 评估标准：完整决策链路（6个步骤）

### Step 1: 基础方案（必备，缺失则不超过0.4）
- 给出了可运行的Python脚本，能批量读取Excel、合并汇总、生成总表
- 包含了面向非技术用户的使用说明（如何安装、如何运行）

### Step 2: 数据质量处理与矛盾分析（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **列名容错处理**：是否在方案中设计了列名映射/模糊匹配机制，处理各所列名不统一的问题 (+0.05)
- **发现并分析数据矛盾**：是否注意到接警总数(45)与分类之和(38)不一致，并分析了可能原因（分类遗漏、录入错误、统计口径差异等） (+0.05)
- **自动校验机制**：脚本中是否加入了数据校验逻辑（如接警总数==各分类之和），并对异常数据做标记/告警 (+0.05)
- 如果助手完全没有关注数据质量问题，此项得0

### Step 3: 环境适配（必备，缺失则不超过0.6）
- 考虑了离线安装Python的方案（如提供离线包安装步骤、或建议走信息科审批流程）
- 考虑了数据保密要求（全程本地处理，不依赖云服务）
- 给出了适配Windows环境的具体操作步骤

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **RPA vs 脚本选型分析**：解释了为什么简单场景用Python脚本比RPA更轻量合适，什么场景才需要RPA（如需要操作GUI、登录系统等） (+0.04)
- **公安数据管理规范**：提到了接处警数据的管理要求（内部使用、本地处理、审计留痕等），方案设计符合公安信息化管理规范 (+0.04)
- **数据治理建议**：建议从源头规范各所的报表格式（如下发统一模板、锁定列名），而非仅靠脚本容错 (+0.04)
- **渐进式自动化路径**：提出了从脚本 → 定时任务 → 对接警综平台API的渐进升级路线 (+0.04)
- **Word简报生成**：方案中包含了自动生成Word版日报简报的功能（用python-docx等） (+0.04)

### Step 5: 综合建议（加分项，+0.05）
- 综合了用户的技术水平、环境限制、数据安全要求给出个性化建议
- 考虑了用户提到的领导想做趋势分析的需求，给出了扩展方向

### Step 6: 可操作的行动方案（加分项，+0.04）
- 给出了具体的实施步骤（第一步找信息科审批装Python、第二步…）
- 使用了结构化格式（步骤清单），方便用户直接参照执行
- 考虑了实施风险（如信息科不批Python怎么办的备选方案）

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（数据质量与矛盾处理）：最高 +0.15（这是拉开差距的关键维度）
- Step 4 每个知识点 +0.04（最高 +0.20）
- Step 5: +0.05
- Step 6: +0.04
- 理论满分路径：0.5 + 0.15 + 0.20 + 0.05 + 0.04 = 0.94
- 如果在以上基础上回答特别出色（如给出了用户没想到的洞察），可酌情给到 1.0"""

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

        # 2. Trajectory quality (20%) — full conversation intent understanding
        trajectory_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.TRAJECTORY_RUBRIC)
            trajectory_score = result.score
            print(f"[grader] trajectory score: {trajectory_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] trajectory judge failed: {exc}")

        # 3. Numerical/technical accuracy (25%)
        numerical_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.NUMERICAL_RUBRIC)
            numerical_score = result.score
            print(f"[grader] numerical score: {numerical_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] numerical judge failed: {exc}")

        # 4. Content quality (40%)
        content_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.CONTENT_RUBRIC)
            content_score = result.score
            print(f"[grader] content score: {content_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] content judge failed: {exc}")

        # Combine: 15% clarify + 20% trajectory + 25% numerical + 40% content
        scores.completion = round(
            0.15 * clarify_score +
            0.20 * trajectory_score +
            0.25 * numerical_score +
            0.40 * content_score,
            4
        )
        print(f"[grader] completion: {scores.completion:.4f} "
              f"(clarify={clarify_score:.2f}*0.15 + trajectory={trajectory_score:.2f}*0.20 "
              f"+ numerical={numerical_score:.2f}*0.25 + content={content_score:.2f}*0.40)")

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
