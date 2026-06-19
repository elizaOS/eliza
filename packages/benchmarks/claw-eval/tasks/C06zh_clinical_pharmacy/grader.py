"""C06zh_clinical_pharmacy grader — multi-turn user-agent consultation: 临床药学."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA9Grader(UserAgentClarifyGraderBase):
    """临床药学 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "临床药学"
    MUST_ASK = [
        "患者的年龄、体重及性别",
        "患者当前的肾功能指标（肌酐值或估算的肌酐清除率）",
        "患者目前所有药物的精确剂量及用药频率",
        "患者是否存在其他合并症或电解质异常情况",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做临床决策所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 患者的年龄、性别和体重（计算CrCl必需）
  - 患者当前的肾功能指标（肌酐值或CrCl）
  - 所有药物的精确剂量和用药频率
  - 现有的电解质结果（特别是血钾）

## 深入信息（好的临床药师会进一步追问，每覆盖一项加分）
  - 其他合并症（如糖尿病、高血压等，影响用药选择）
  - 当前是否还有其他合并用药（如利尿剂、降压药等）
  - 最近的地高辛血药浓度（如果有）
  - 最近的心电图结果（心率、QT间期等）
  - 肝功能情况（影响胺碘酮代谢）

评分标准：
- 1.0：基础信息全部收集 + 主动追问了2项以上深入信息
- 0.8-0.9：基础信息全部收集 + 追问了1项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 临床信息收集应体现专业性和系统性"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户初始 query 提到了胺碘酮+地高辛+华法林+螺内酯，但缺少：
  - 患者具体年龄、体重（计算CrCl需要）
  - 精确的药物剂量
  - 具体的肾功能指标数值
- 助手是否在第一轮就识别出这些缺失并系统地询问

### 2. 信息修正捕捉
- 用户会在对话中补充：82岁男性/60kg/肌酐156-165
- 用户还会补充主治拟加的新药：螺内酯25mg、培哚普利4mg
- 助手是否准确捕捉到每次新增信息并更新分析

### 3. 需求演变跟踪
- 用户的需求从"药物相互作用"→"具体减量方案"→"如何向主治提出建议"→"文献引用"→"利尿剂配比"
- 助手是否跟上了需求的自然演变
- 特别是"怎么跟主治说"这种沟通技巧需求——是否给了实用建议

### 4. 工具使用合理性（如果助手使用了计算工具）
- CrCl计算需要精确——是否使用工具计算而非心算
- **错误与修正的评判标准（严格执行）**：
  - 一次计算就得到正确CrCl = 最优
  - 计算出错但自行修正 = 次优，扣0.1-0.2
  - 计算出错未发现 = 严重问题，扣0.3-0.5

### 5. 对话节奏控制
- 是否在获得关键参数后及时给出风险评估
- 是否在用户追问时流畅衔接

### 6. 搜索工具使用质量（如适用）
本任务涉及药物相互作用数据和临床指南，搜索可用于查找：
- 最新的药物相互作用数据
- 特定人群的剂量调整指南
- 文献引用（用户明确要求了Juurlink NEJM文献）

**搜索质量评估：**
- 优秀(不扣分)：搜索了药物相互作用数据库或临床指南
- 未搜索(扣0.05)：完全凭记忆回答药物交互——临床药学知识相对稳定，凭记忆可以接受，但如果记忆有误则需扣分
- 用户要求特定文献引用时：应尝试搜索找到准确引用信息

## 评分标准
- 1.0：每一轮都精准理解用户意图，临床判断专业准确
- 0.7-0.9：整体理解准确，偶有一轮不够精准
- 0.4-0.6：部分轮次理解偏差（如忽略了新增药物、未更新分析）
- 0.1-0.3：多轮对话中反复出现专业判断错误
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算和剂量建议的准确性（0.0-1.0）。不要考虑内容质量，只关注数字和剂量对不对。

## 话题一致性（前置检查）
原始问题是关于「老年肾功能不全患者的多重药物相互作用评估和剂量调整」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数
  - 患者：82岁男性，体重约60kg
  - 肌酐：156-165 μmol/L
  - 现用药：地高辛0.125mg qd，胺碘酮（剂量未明确）
  - 拟加药：螺内酯25mg，培哚普利4mg

## 正确参考值（Cockcroft-Gault公式程序化计算）

**CrCl计算：**
公式：CrCl = [(140 - age) × weight] / (72 × Scr_mg/dL)
Scr单位换算：μmol/L ÷ 88.4 = mg/dL

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| Scr换算（取160 μmol/L） | **1.81 mg/dL** | +/- 0.1 |
| CrCl（取Scr=160） | **26.7 mL/min** | +/- 5 mL/min |
| CrCl范围（Scr 156-165） | **25.9 - 27.4 mL/min** | +/- 5 mL/min |
| 肾功能分级 | **中重度肾功能不全（CKD 4期）** | — |

注意：GT参考答案用简化公式 (140-82)*60/(72*160/88.4)≈30 得到了约30 mL/min。
实际精确值约26-27。两种算法差异可接受，关键是不能算出>40或<15。

**关键剂量判断：**

| 检查项 | 正确建议 | 评判标准 |
|--------|----------|----------|
| 地高辛调整 | **减量至0.0625mg qd（或隔日0.125mg）** | 必须建议减量，不减量=严重错误 |
| 地高辛目标浓度 | **0.5-0.9 ng/mL** | 正确范围应在0.5-1.0区间 |
| 胺碘酮对地高辛影响 | **升高50%-100%** | 应指出显著升高，不低于30% |
| 培哚普利剂量 | **CrCl<30时应减至2mg** | 应指出4mg在此肾功能下偏高 |
| 螺内酯+ACEI高钾风险 | **极高风险** | 必须明确指出 |
| 血钾警戒值 | **>5.0 mmol/L需减量或停药** | 应给出具体阈值 |

## 评分规则（严格执行）
- 1.0：CrCl计算准确 + 所有剂量建议正确
- 0.7-0.9：CrCl基本正确，剂量建议大方向对但细节有偏差
- 0.4-0.6：CrCl偏差较大（但仍识别为肾功能不全），或漏了一个关键剂量建议
- 0.2-0.3：CrCl计算错误导致肾功能分级错误，或未建议地高辛减量
- 0.0-0.1：完全未计算CrCl，或剂量建议方向性错误（如建议地高辛增量）
- 如果未识别胺碘酮-地高辛交互作用 → 最高0.3
- 如果未识别螺内酯-培哚普利高钾风险 → 最高0.4"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「老年肾功能不全患者的多重药物联用风险评估和剂量调整方案」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 82岁男性，60kg，肌酐156-165 μmol/L
  - 现用药：胺碘酮200mg qd + 地高辛0.125mg qd + 华法林3mg qd
  - 主治拟调整：地高辛改为隔日一次 + 加用螺内酯25mg + 培哚普利4mg
  - 最近INR 2.8（治疗范围内），血钾4.6 mmol/L
  - 地高辛谷浓度1.8 ng/mL（在合用胺碘酮情况下测的）
  - 可能还在用呋塞米（40mg或20mg不确定）
  - 房颤+心衰患者
  - 用户是心内科护师，需要能向主治医生提出建议的依据
  - 用户明确要求了Juurlink的NEJM文献引用

## 关键矛盾（高质量回答应发现并分析）

**矛盾一：隔日给药的波动问题**
主治说"减成隔日一次"（地高辛0.125mg隔日），这相当于日均剂量~0.0625mg。但隔日给药在药代动力学上意味着给药日血药浓度高、间隔日浓度低——对于82岁肾功能不全的患者，地高辛半衰期延长，这种波动尤其不利。更优方案是改为0.0625mg每日一次（半片），提供更稳定的血药浓度。好的助手应该指出隔日给药方案的波动劣势。

**矛盾二：血钾4.6的隐藏风险**
血钾4.6 mmol/L表面上在正常范围（3.5-5.0），但这是在加用螺内酯+培哚普利之前的基线值。
螺内酯（保钾利尿剂）+ 培哚普利（ACEI，也升钾）+ 肾功能不全（排钾能力下降）三重因素叠加，4.6这个基线已经偏高，加药后极易突破5.0甚至5.5。好的助手应该警示这个基线钾+三重升钾因素的危险组合。

## 评估标准：完整决策链路

### Step 1: 肾功能评估（必备，缺失则不超过0.3）
- 使用Cockcroft-Gault公式估算CrCl
- 明确判定肾功能不全的程度（中重度/CKD分期）
- 指出肾功能对所有经肾排泄药物的影响

### Step 2: 信息验证与矛盾处理（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **隔日给药波动分析**：是否指出地高辛隔日给药（0.125mg qod）虽然日均剂量约0.0625mg，但血药浓度波动大（给药日峰值高、间隔日谷值低），对于82岁肾功能不全患者（半衰期延长至36-48h+），建议改为0.0625mg qd（每日半片）以获得更稳定的血药浓度？(+0.05)
- **血钾基线风险预判**：是否指出4.6 mmol/L作为加药前的基线值已偏高，在叠加螺内酯（保钾）+ 培哚普利（ACEI升钾）+ CrCl~27（排钾受限）三重因素后，高钾风险极高，应在加药前就将血钾控制到<4.5，并建议加药后48-72h内复查血钾？(+0.05)
- **谷浓度与胺碘酮的关联**：如果用户透露了地高辛谷浓度1.8 ng/mL，是否指出这个浓度是在合用胺碘酮的情况下测的，已远超老年人推荐的<1.0 ng/mL，说明当前0.125mg qd已经过量？(+0.05)
- 如果助手只是简单说"建议减量"而没有分析隔日vs每日给药的差异，此项最多得0.05

### Step 3: 核心药物相互作用分析（必备，缺失则不超过0.4）
- **胺碘酮+地高辛**：P-糖蛋白抑制导致地高辛浓度升高的机制
- **螺内酯+培哚普利**：双重升钾风险
- **培哚普利与肾功能**：ACEI类可能加重肾功能恶化

### Step 4: 具体剂量调整建议（必备，缺失则不超过0.5）
- 地高辛的减量方案（具体到多少mg，多少频次）
- 培哚普利在肾功能不全时的起始剂量
- 螺内酯的风险收益权衡

### Step 5: 监测方案（重要加分项，+0.10）
- 给出了具体的监测项目（血钾、肾功能、地高辛浓度、心电图等）
- 给出了合理的监测频率（初期密集→稳定后减频）
- 列出了需要关注的临床症状（地高辛中毒征象、高钾症状等）

### Step 6: 领域知识应用（加分项，每项 +0.04）
- **CrCl计算方法论**：是否正确使用Cockcroft-Gault公式（而非MDRD或CKD-EPI），并说明了为何CG公式在老年患者药物剂量调整中仍是首选（多数药品说明书以CG-CrCl为标准） (+0.04)
- **胺碘酮-地高辛相互作用定量**：是否给出了具体的浓度升高幅度（30-70%或50-100%），而不仅仅定性说"会升高"；是否提到P-糖蛋白和CYP3A4双通路抑制机制 (+0.04)
- **胺碘酮-华法林相互作用**：是否指出胺碘酮抑制CYP2C9导致华法林代谢减慢，当前INR 2.8在加用新药后可能进一步升高，需要密切监测INR并可能需要减华法林剂量 (+0.04)
- **RALES试验/Juurlink NEJM证据引用**：是否提到了RALES试验（螺内酯在心衰中的获益证据）以及Juurlink 2004 NEJM的研究（RALES发表后螺内酯处方增加导致高钾相关死亡增加），为向主治提建议提供循证依据 (+0.04)
- **老年人地高辛谷浓度目标<1.0**：是否明确指出老年患者（尤其是心衰+房颤）地高辛谷浓度应控制在0.5-0.9 ng/mL（DIG试验亚组分析），超过1.0 ng/mL死亡率不降反升 (+0.04)

### Step 7: 安全警示与沟通建议（加分项，+0.05）
- 明确指出这是高风险多重用药方案
- 建议请临床药师会诊
- 强调任何剂量变动后需加强监测
- 如何向主治提出剂量调整建议（用户明确需要这个）

## 评分汇总
- Step 1 + Step 3 + Step 4 都满足：基础分 0.50
- Step 2（矛盾处理）：最高 +0.15（关键区分维度）
- Step 5（监测方案）：+0.10
- Step 6 每个知识点 +0.04（最高 +0.20）
- Step 7: +0.05
- 理论满分路径：0.50 + 0.15 + 0.10 + 0.20 + 0.05 = 1.00
- 如果专业水平特别出色（如给出了完整的药物调整时间线和随访计划），可酌情给到 1.0"""

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

        # 3. Numerical accuracy (35%)
        numerical_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.NUMERICAL_RUBRIC)
            numerical_score = result.score
            print(f"[grader] numerical score: {numerical_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] numerical judge failed: {exc}")

        # 4. Content quality (30%)
        content_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.CONTENT_RUBRIC)
            content_score = result.score
            print(f"[grader] content score: {content_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] content judge failed: {exc}")

        # Combine: 15% clarify + 20% trajectory + 35% numerical + 30% content
        scores.completion = round(
            0.15 * clarify_score +
            0.20 * trajectory_score +
            0.35 * numerical_score +
            0.30 * content_score,
            4
        )
        print(f"[grader] completion: {scores.completion:.4f} "
              f"(clarify={clarify_score:.2f}*0.15 + trajectory={trajectory_score:.2f}*0.20 "
              f"+ numerical={numerical_score:.2f}*0.35 + content={content_score:.2f}*0.30)")

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
