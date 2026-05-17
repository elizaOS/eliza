"""C28zh_distributed_systems grader — multi-turn user-agent consultation: 分布式系统."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA225Grader(UserAgentClarifyGraderBase):
    """分布式系统 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "分布式系统"
    MUST_ASK = [
        "worker实例数量和并发模式",
        "当前锁实现方式（setnx+expire）和TTL设置",
        "Redis部署架构（单节点、哨兵还是集群）",
        "处理时间分布（平均和峰值）",
        "是否有watchdog续期机制",
        "客户端库类型（redis-py / Jedis等）",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做决策所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - worker实例数量和并发模式
  - 当前锁实现方式和TTL设置
  - Redis部署架构（单节点/哨兵/集群）
  - 处理时间分布（平均和峰值，用于判断TTL是否合理）

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 是否有watchdog/续期机制
  - 客户端库类型（redis-py / Jedis / Lettuce等）
  - 锁粒度（全局锁还是per-task锁）
  - 偶发超时的具体表现（只是慢还是有状态混乱）
  - 是否已观察到并发写入/状态覆盖的实际case

评分标准：
- 1.0：基础信息全部收集 + 主动追问了2项以上深入信息
- 0.8-0.9：基础信息全部收集 + 追问了1项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接基于不完整信息给方案
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息（如prompt中已提到多实例并发、偶发超时），助手只需询问缺失的部分
- 特别重要：助手是否追问了TTL和处理时间的具体数值——这是发现root cause的关键线索"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. Root Cause识别（最关键维度）
- 用户说"锁竞争"，但真正问题是"锁过期"——TTL 5秒但处理偶尔到8秒，锁提前过期导致并发写入
- 助手是否区分了"锁竞争"（多线程争抢锁，正常行为）和"锁过期/锁失效"（持锁方未完成处理锁就释放了，这才是bug）
- 如果助手只是顺着用户说"锁竞争"给方案而没有纠正，扣0.2-0.3

### 2. Redlock适用性判断
- 用户想用Redlock，但Redis是单节点
- Redlock是为多个独立Redis节点设计的分布式共识算法（需要>=3个，推荐5个独立Redis实例）
- 在单节点上用Redlock毫无意义，好的助手应明确指出这一点
- 如果助手没有指出Redlock在单节点上不适用，扣0.1-0.2

### 3. 信息修正捕捉
- 用户可能先说Python然后透露锁那块其实是Java(Jedis)在管
- 助手是否准确捕捉到了这个矛盾并调整建议

### 4. 工具使用合理性
- **计算工具**：概率估算（P(X>TTL)）适合用计算工具精确计算而非心算
  - 一次通过最优，自我修正次优（扣0.1-0.2），错误未发现最差（扣0.3-0.5）
- **搜索工具**：可搜索Martin Kleppmann对Redlock的批评、Redis官方锁文档等
  - 精准搜索1-3次最优，过度搜索6+次扣0.1
  - 完全不搜但给出正确信息可接受（分布式锁是成熟话题）

### 5. 对话节奏控制
- 是否在收集到足够信息后及时给出诊断和方案
- 是否在发现root cause后清晰地向用户解释，而非堆砌技术细节

## 评分标准
- 1.0：精准识别root cause（锁过期而非锁竞争），指出Redlock不适用于单节点，工具使用高效，对话节奏好
- 0.7-0.9：识别了锁过期问题但表述不够清晰，或Redlock分析到位但root cause分析略有偏差
- 0.4-0.6：部分识别问题但混淆了锁竞争和锁过期，或未指出Redlock在单节点上的局限
- 0.1-0.3：完全没有识别root cause，顺着用户的错误判断给方案
- 0.0：完全无法理解问题"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算和定量分析准确性（0.0-1.0）。不要考虑内容质量，只关注数字和量化推理对不对。

## 话题一致性（前置检查）
原始问题是关于「Redis分布式锁在高并发场景的选型和问题诊断」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数
  - worker实例数: 8个
  - 当前锁: setnx + expire, TTL = 5秒
  - 处理时间: 平均2-3秒，偶尔到8秒
  - Redis: 单节点

## 正确参考值（程序化计算，假设处理时间服从正态分布N(3, 1.5²)）

### 锁过期概率估算

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| P(单次处理时间 > TTL 5秒) | **9.1%** | ±3%（6%-12%均可接受，不同分布假设会有差异） |
| 8个worker下每轮至少一个超TTL的概率 | **53%** | ±15%（38%-68%均可接受） |

### TTL建议值

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| P99处理时间 | **6.5秒** | ±1秒 |
| P99.9处理时间 | **7.6秒** | ±1秒 |
| 建议TTL下限 | **10-15秒** | 只要 >= 8秒且有合理依据即可 |

注意：
- 分布假设不唯一。用户只说了"平均2-3秒偶尔到8秒"，助手可能假设正态、对数正态、或经验分布。只要假设合理且计算过程正确即可
- 如果助手没有做任何定量估算，只是定性说"TTL太短了"，最高给0.4
- 如果助手用了计算工具（Bash）做概率估算且结果正确，加分
- 如果助手给出了watchdog续期的建议作为替代定量TTL设置，这是合理的，但仍应估算当前配置下的风险概率

## 评分规则（严格执行）
- 1.0：概率估算在误差范围内，TTL建议有定量依据，计算过程清晰
- 0.7-0.9：概率估算基本正确（数量级对），TTL建议合理但依据不够精确
- 0.4-0.6：指出了TTL < 峰值处理时间的问题，做了定性分析但缺少定量估算
- 0.2-0.3：提到了TTL相关问题但分析不深入，没有概率估算
- 0.0-0.1：完全没有分析TTL和处理时间的关系，或数值计算严重错误"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「Redis分布式锁在高并发场景的选型（Redlock vs setnx）」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 8个worker实例并发poll任务并更新状态
  - 任务状态: 每个task一个Redis hash（当前节点、上下文snapshot、retry count）
  - 锁实现: setnx + expire, TTL 5秒
  - 处理时间: 平均2-3秒，偶尔到8秒
  - Redis: 单节点（非集群非哨兵）
  - 客户端: Jedis（Java服务管锁，Python做其他）
  - 无watchdog续期机制
  - 实际已出现同一task被两个worker同时写入的情况

## 关键矛盾（高质量回答应发现并分析）
用户自述"锁竞争"，但真正问题是"锁过期"：
  - TTL 5秒 < 偶发处理时间8秒 → 持锁worker还没完成，锁已过期 → 其他worker获取锁并发写入
  - 这不是锁竞争（lock contention，正常的多线程争抢），而是锁失效（lock expiration，设计缺陷）
  - 好的助手应清晰区分这两个概念，并解释为什么用户的诊断方向偏了

## 评估标准：完整决策链路

### Step 1: Root Cause诊断（必备，缺失则不超过0.4）
- 明确指出问题是锁过期而非锁竞争
- 解释TTL < 最大处理时间导致的并发写入机制
- 不能只说"TTL太短"而不解释为什么这才是root cause

### Step 2: Redlock适用性分析（重要，缺失则不超过0.6，+0.15）
- **指出Redlock在单节点上无意义**：Redlock是Antirez提出的分布式共识锁算法，需要N个独立Redis master（推荐5个），通过多数派投票确保锁的可靠性。单节点上Redlock退化为普通setnx (+0.05)
- **提及Redlock的争议**：Martin Kleppmann的"How to do distributed locking"批评了Redlock的安全性论证，指出即使用Redlock仍需fencing token (+0.05)
- **给出正确结论**：用户场景（单节点Redis + 非金融级一致性需求）不需要Redlock，问题出在TTL配置而非锁算法 (+0.05)

### Step 3: 解决方案（必备，缺失则不超过0.6）
至少涵盖以下方案中的2-3个：
- **方案A: Watchdog续期机制**——后台线程定期检查锁持有状态并续期（如Redisson的看门狗模式），从根本上解决TTL < 处理时间的问题
- **方案B: 增大TTL + fencing token**——TTL设为P99/P999处理时间 + buffer，配合fencing token（单调递增ID）做幂等校验
- **方案C: Lua脚本原子操作**——将"读取-判断-更新"打包为Lua脚本在Redis端原子执行，避免需要持锁的时间窗口
- **方案D: WATCH/MULTI乐观锁**——适合冲突率低的场景，用CAS语义替代悲观锁

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **锁安全性 vs 活性分析**：区分safety property（互斥）和liveness property（无死锁/最终获取），解释当前方案违反了safety (+0.04)
- **Jedis vs Lettuce/redis-py的锁支持差异**：Jedis没有内置的看门狗机制（不像Redisson），需要自行实现续期逻辑 (+0.04)
- **fencing token模式**：解释如何用单调递增token让下游存储拒绝过期锁的写入，即使锁过期也不会导致数据不一致 (+0.04)
- **etcd/ZooKeeper对比**：用户CTO提过etcd——简要分析基于etcd/ZK的锁（基于lease+session，天然支持续期）vs Redis锁的trade-off (+0.04)

### Step 5: 综合建议（加分项，+0.05）
- 结合用户的具体场景（单节点Redis、Jedis、8 worker、非金融级需求）给出个性化推荐
- 建议有优先级排序，而非罗列所有可能方案

### Step 6: 可操作的行动方案（加分项，+0.04）
- 给出具体的代码示例或伪代码（如Jedis实现watchdog续期、Lua脚本CAS操作）
- 给出TTL参数调整的具体建议值

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（Redlock分析）：最高 +0.15
- Step 4 每个知识点 +0.04（最高 +0.16）
- Step 5: +0.05
- Step 6: +0.04
- 理论满分路径：0.5 + 0.15 + 0.16 + 0.05 + 0.04 = 0.90
- 如果在以上基础上回答特别出色（如给出了用户没想到的深入洞察），可酌情给到 1.0"""

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
