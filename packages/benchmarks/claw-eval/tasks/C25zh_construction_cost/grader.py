"""C25zh_construction_cost grader — multi-turn user-agent consultation: 工程造价."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA211Grader(UserAgentClarifyGraderBase):
    """工程造价 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "工程造价"
    MUST_ASK = [
        "设计荷载条件（活载、吊挂荷载等）",
        "屋面系统做法（面板材料、保温构造）",
        "节点形式（螺栓球/焊接球/相贯节点）",
        "用途场景（是概算取值还是仅了解行情）",
        "总面积或工程规模",
        "预算限额或造价控制目标",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做决策所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 设计荷载条件（活载、吊挂荷载等）
  - 屋面系统做法（面板材料、保温构造）
  - 节点形式（螺栓球/焊接球/相贯节点）
  - 用途场景（是概算取值还是仅了解行情）

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 总面积或工程规模（影响总价和是否有规模效应）
  - 预算限额或造价控制目标（300万）
  - 所在地区（影响人工费和运输费）
  - 工期要求（赶工会增加费用）
  - 防腐防火等级要求
  - 是否含吊顶、灯具预埋等二次结构

评分标准：
- 1.0：基础信息全部收集 + 主动追问了2项以上深入信息（特别是面积和预算）
- 0.8-0.9：基础信息全部收集 + 追问了1项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接基于不完整信息给出回答
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问
- 提问应该自然、友好，不像在审问用户"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始query只给了跨度45m和"不含幕墙机电"，缺少荷载条件、节点形式、屋面做法、面积、预算等关键参数
- 助手是否在第一轮就识别出缺失并主动询问，而非先给模糊回答再补问

### 2. 需求演变跟踪
- 用户从"了解行情"逐步演变为"需要填概算表的推荐取值"再到"预算300万够不够"
- 助手是否跟上了需求的深化，从给区间到给具体推荐值到做预算分析

### 3. 信息矛盾处理
- 用户说"去年有人说600到900"，但2025年钢材价格波动大
- 助手是否注意到去年报价可能已不适用，主动搜索验证当前行情
- 如果直接沿用去年数据而不做任何验证，应扣分

### 4. 工具使用合理性
#### 计算工具：
- 是否在需要精确计算时主动调用计算工具（用钢量估算、单价计算、总价计算）
- 一次通过最优，自我修正次优（扣0.1-0.2），错误未发现最差（扣0.3-0.5）

#### 搜索工具使用质量：
本任务涉及时效性信息（2025年钢材价格、铝锭价格），好的助手应主动搜索验证。

**搜索必要性判断：**
- 钢材价格（Q235B热轧型钢）是时效性极强的信息，月度波动可达5-10%
- 铝锭价格同理，直接影响铝镁锰板成本
- 网架加工费、安装费的市场行情也在变化

**搜索质量评估：**
- 优秀(不扣分)：搜索了2025年最新钢材价格或网架造价行情，1-3次精准搜索
- 良好(扣0.05)：搜索了但查询不够精准，需4-5次才找到关键信息
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索相同内容
- 较差(扣0.15)：搜索了但结果没有被使用或被错误解读
- 未搜索(扣0.1)：完全没搜索，直接凭记忆给出钢材价格，存在信息过时风险；若凭记忆给出的价格恰好合理，可减轻扣分至0.05

### 5. 对话节奏控制
- 是否在收集到足够参数后及时给出阶段性结论
- 是否在用户追问预算时能快速响应而非重新追问已知信息

## 评分标准
- 1.0：每一轮都精准理解用户意图，信息矛盾处理得当，工具使用高效恰当
- 0.7-0.9：整体理解准确，工具使用基本合理，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显，或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字对不对。

## 话题一致性（前置检查）
原始问题是关于「45m跨度螺栓球钢网架屋盖每平米造价估算」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数（对话中逐步透露）
  - 跨度：约45m
  - 节点形式：螺栓球节点
  - 设计荷载：活载0.5kN/m2，吊挂荷载0.3kN/m2
  - 屋面系统：铝镁锰板+保温
  - 总面积：约3200m2
  - 预算：300万以内
  - 不含幕墙机电

## 正确参考值（程序化计算）

### 一、钢网架结构部分
| 检查项 | 正确范围 | 允许误差 |
|--------|----------|----------|
| 45m跨度螺栓球网架用钢量 | **35-50 kg/m2** | 30-55均可接受 |
| 钢材单价（2025年Q235B） | **4000-5500 元/吨** | 3500-6000均可接受 |
| 网架综合吨价（含加工球节点安装） | **7000-9500 元/吨** | 6000-11000均可接受 |
| 结构部分综合单价 | **280-450 元/m2** | 200-500均可接受 |

### 二、屋面系统部分（铝镁锰板+保温）
| 检查项 | 正确范围 | 允许误差 |
|--------|----------|----------|
| 铝镁锰板+保温+防水+檩条支托综合单价 | **200-350 元/m2** | 150-400均可接受 |

### 三、综合单价与总价
| 检查项 | 正确范围 | 允许误差 |
|--------|----------|----------|
| 综合单价（结构+屋面） | **500-750 元/m2** | 400-900均可接受 |
| 概算推荐取值 | **550-750 元/m2** | 应给出具体数值而非仅给区间 |
| 3200m2总造价 | **160-240 万** | 130-290万均可接受 |
| 是否在300万预算内 | **是（大概率在预算内）** | 应明确回答预算够用但需留余量 |

### 四、关于"去年600到900"
| 检查项 | 正确判断 |
|--------|----------|
| 600-900是否合理 | 偏高但可能包含更多项目，或不同工况/地区差异 |
| 与当前估算的关系 | 应分析差异原因（工况不同、价格变化等） |

## 评分规则（严格执行，不要被内容质量影响）
- 1.0：综合单价在500-750范围内，总造价计算正确，预算判断正确，分项数据合理
- 0.7-0.9：综合单价在合理范围（400-900），总造价基本正确，分项有小偏差
- 0.4-0.6：给出了具体数值但偏差较大（综合单价超出400-900范围），或总造价计算有明显错误
- 0.2-0.3：只给了极宽泛的区间（如"几百到一千多"）没有具体数值，或关键参数使用错误
- 0.0-0.1：完全没有给出任何数值，或数值严重离谱（如综合单价超过2000或低于200）
- 如果助手引用的面积与用户提供的3200m2不一致（如按1000m2算），在总价部分扣分但单价部分不受影响"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「45m跨度螺栓球钢网架屋盖每平米造价估算」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 主任建筑师，需要填概算表
  - 跨度45m，螺栓球节点，活载0.5kN/m2+吊挂0.3kN/m2，铝镁锰板+保温
  - 总面积3200m2，预算300万
  - 去年听说600到900，想知道今年行情
  - 不含幕墙机电

## 关键矛盾（高质量回答应发现并分析）
用户提供的信息中存在需要辨析的问题：
  - 用户说"去年有人说600到900"——这个数据的工况可能不同（不同跨度、不同节点、不同屋面做法）
  - 2025年钢材价格相比2024年有波动，直接沿用去年数据不严谨
  - 好的助手应搜索最新钢材/铝材价格，对比分析而非简单引用旧数据
  - 预算300万对应单价上限938元/m2，表面看够用，但应考虑不可预见费、税金等

## 评估标准：完整决策链路（6个步骤）

### Step 1: 分项造价估算（必备，缺失则不超过0.4）
- 将钢网架屋盖造价拆分为结构部分和屋面系统部分分别估算
- 结构部分：给出用钢量估算、综合吨价或综合单价
- 屋面部分：给出铝镁锰板+保温+檩条系统综合单价
- 最终汇总为综合单价

### Step 2: 时效性信息验证与矛盾处理（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **搜索最新价格**：是否搜索了2025年最新钢材价格（Q235B热轧）和铝锭价格，而非凭记忆给出 (+0.05)
- **分析去年报价差异**：是否分析了"去年600到900"与当前估算的差异原因（工况不同、钢价变化、报价口径不同等） (+0.05)
- **价格趋势判断**：是否对近期钢材/铝材价格走势做了判断，帮助用户理解当前处于价格周期的什么位置 (+0.05)
- 如果助手直接沿用去年数据或凭记忆给出价格而不做任何验证，此项得0

### Step 3: 预算分析（必备，缺失则不超过0.6）
- 基于3200m2面积和综合单价计算总造价
- 与300万预算对比，给出明确的预算充裕度判断
- 考虑不可预见费、措施费、税金等概算表常规项目对总投资的影响

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **螺栓球vs焊接球**：说明螺栓球节点的用钢量特点（比焊接球略轻但加工费更高），对单价的影响 (+0.04)
- **荷载对用钢量的影响**：分析0.5kN活载+0.3kN吊挂荷载处于什么水平，对用钢量的影响程度 (+0.04)
- **铝镁锰板选型建议**：提到板厚（如0.7mm/0.9mm/1.0mm）对价格的影响，或提到直立锁边等构造做法 (+0.04)
- **概算编制注意事项**：提到概算表中钢网架通常含哪些子项（加工、运输、安装、防腐、防火涂料等），哪些容易遗漏 (+0.04)
- **价格波动风险提示**：提到钢材价格波动对概算的影响，建议预留调价余量或设置价格调整条款 (+0.04)

### Step 5: 概算表推荐取值（加分项，+0.05）
- 给出了具体的概算表推荐取值（一个明确的数字，而非只给区间）
- 说明了取值依据和适用前提
- 建议考虑了用户作为设计院主任建筑师填概算的实际需求（偏保守留余量）

### Step 6: 结构化输出（加分项，+0.04）
- 使用了分项表格或清单格式，方便直接引用到概算表
- 列出了各分项的单价和取值依据

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（矛盾处理）：最高 +0.15（这是拉开差距的关键维度）
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
