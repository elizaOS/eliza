export type CoordinatorEvalChannel =
  | "app_chat"
  | "discord"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "signal"
  | "matrix"
  | "wechat";

export type CoordinatorScenarioFamily =
  | "build_and_edit"
  | "continuation"
  | "preview_and_share"
  | "pause_resume_stop"
  | "history_and_reporting"
  | "research_and_planning"
  | "connector_behavior"
  | "recovery_and_failover"
  | "task_management"
  | "visibility_and_audit";

export type CoordinatorScenarioProfile = "smoke" | "core" | "full";

export type CoordinatorScenarioTurn = {
  speaker: "user";
  text: string;
};

export interface CoordinatorScenario {
  id: string;
  family: CoordinatorScenarioFamily;
  profile: CoordinatorScenarioProfile;
  title: string;
  summary: string;
  channels: CoordinatorEvalChannel[];
  requiredCapabilities: string[];
  turns: CoordinatorScenarioTurn[];
  doneWhen: string[];
  evidence: string[];
}

const ALL_CHANNELS: CoordinatorEvalChannel[] = [
  "app_chat",
  "discord",
  "telegram",
  "slack",
  "whatsapp",
  "signal",
  "matrix",
  "wechat",
];

function scenario(value: CoordinatorScenario): CoordinatorScenario {
  return value;
}

export const coordinatorScenarios: CoordinatorScenario[] = [
  scenario({
    id: "B001",
    family: "build_and_edit",
    profile: "smoke",
    title: "build a personal birthday page and keep iterating",
    summary:
      "The user asks for a small web page, then asks to view it and refine it without restating the whole task.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "create_task",
      "continue_task",
      "artifact_visibility",
    ],
    turns: [
      {
        speaker: "user",
        text: "Can you make a little web page for me that shows my birthday, March 14, 1991, and my astrological sign?",
      },
      { speaker: "user", text: "Can I view that?" },
      {
        speaker: "user",
        text: "Change it so it also shows the weekday I was born on.",
      },
    ],
    doneWhen: [
      "A task thread exists for the work.",
      "The agent produces a concrete preview artifact, file path, or URL.",
      "The follow-up request is treated as continuation of the same work.",
    ],
    evidence: [
      "task thread",
      "task artifacts",
      "trajectory records",
      "changed files",
    ],
  }),
  scenario({
    id: "B002",
    family: "build_and_edit",
    profile: "core",
    title: "build a landing page from a vague aesthetic brief",
    summary:
      "The user gives an intentionally fuzzy request and the agent must still create a concrete artifact and continue refining it.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "create_task",
      "clarify_or_execute",
      "artifact_visibility",
    ],
    turns: [
      {
        speaker: "user",
        text: "Make me a small homepage that feels kind of dreamy and strange.",
      },
      { speaker: "user", text: "Can you make it less cute and more severe?" },
      { speaker: "user", text: "Can I see the current version?" },
    ],
    doneWhen: [
      "The agent either asks a targeted clarification or starts building immediately.",
      "A previewable result is produced.",
      "The refinement request updates the same thread.",
    ],
    evidence: ["task thread", "artifacts", "transcripts", "changed files"],
  }),
  scenario({
    id: "B003",
    family: "build_and_edit",
    profile: "core",
    title: "create a script and then explain how to run it",
    summary:
      "The user asks for code and then asks how to execute it locally and from another machine.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "create_task",
      "continue_task",
      "share_or_run_guidance",
    ],
    turns: [
      {
        speaker: "user",
        text: "Write a script that takes a folder of markdown files and makes one combined HTML page.",
      },
      { speaker: "user", text: "How do I run it?" },
      { speaker: "user", text: "Can I run it from a remote computer too?" },
    ],
    doneWhen: [
      "A task thread is created and files are written.",
      "The agent gives concrete run instructions tied to the produced artifact.",
      "The remote-view question is handled as the next step of the same task.",
    ],
    evidence: [
      "task thread",
      "artifacts",
      "trajectory records",
      "changed files",
    ],
  }),
  scenario({
    id: "B004",
    family: "build_and_edit",
    profile: "core",
    title: "make a one-file app and add a final polish pass",
    summary:
      "The user requests a tiny app, then asks the agent to do a final polish pass without specifying exact edits.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["create_task", "continue_task", "iterative_editing"],
    turns: [
      {
        speaker: "user",
        text: "Build me a tiny notes page with local storage.",
      },
      { speaker: "user", text: "Looks close. Do a final polish pass." },
    ],
    doneWhen: [
      "The app is created in files.",
      "A second pass produces additional edits on the same task thread.",
    ],
    evidence: ["changed files", "task thread decisions", "trajectory records"],
  }),
  scenario({
    id: "B005",
    family: "build_and_edit",
    profile: "full",
    title: "implement a code change in an existing repository",
    summary:
      "The user asks for a real repo change and the agent must use repository context instead of scratch space.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["repo_tasking", "create_task", "worktree_artifacts"],
    turns: [
      {
        speaker: "user",
        text: "In the same repo, add a tiny diagnostics page that lists the current task threads.",
      },
      { speaker: "user", text: "Can you show me where you put it?" },
    ],
    doneWhen: [
      "The task uses an existing repo or workspace instead of scratch.",
      "Changed files are present in the repo.",
      "The agent identifies the files or route that was added.",
    ],
    evidence: [
      "task thread",
      "changed files",
      "artifacts",
      "trajectory records",
    ],
  }),
  scenario({
    id: "C001",
    family: "continuation",
    profile: "smoke",
    title: "continue a task from a vague pointer",
    summary:
      "The user refers to earlier work with pronouns and expects continuation.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["continue_task", "thread_lookup", "history_search"],
    turns: [
      { speaker: "user", text: "Can you make a little calendar view for me?" },
      {
        speaker: "user",
        text: "Actually add that thing where I can jump to today.",
      },
      { speaker: "user", text: "Now make it work on mobile too." },
    ],
    doneWhen: [
      "The same thread is reused for follow-up work.",
      "The agent does not spawn unrelated duplicate tasks for simple continuation.",
    ],
    evidence: ["task thread updates", "changed files", "transcripts"],
  }),
  scenario({
    id: "C002",
    family: "continuation",
    profile: "core",
    title: "continue work after a conversational detour",
    summary:
      "The user briefly asks a side question and then returns to the original task.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "continue_task",
      "conversation_memory",
      "thread_lookup",
    ],
    turns: [
      {
        speaker: "user",
        text: "Build me a page that shows my next three reminders.",
      },
      {
        speaker: "user",
        text: "By the way, what model are you using for task work right now?",
      },
      { speaker: "user", text: "Okay continue with the reminder page." },
    ],
    doneWhen: [
      "The side question is answered without losing the main task.",
      "The task resumes on the same thread.",
    ],
    evidence: ["task thread", "task events", "trajectory records"],
  }),
  scenario({
    id: "C003",
    family: "continuation",
    profile: "core",
    title: "treat 'make it so' as approval to execute",
    summary:
      "The user gives a non-specific approval utterance and expects the plan to execute.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["implicit_approval", "task_execution"],
    turns: [
      {
        speaker: "user",
        text: "Can you sketch the approach for a tiny dashboard that shows active tasks and recent completions?",
      },
      { speaker: "user", text: "Yeah I'm down." },
    ],
    doneWhen: [
      "The approval utterance is interpreted as permission to execute.",
      "A real task thread starts and produces artifacts.",
    ],
    evidence: ["task thread", "trajectory records", "artifacts"],
  }),
  scenario({
    id: "C004",
    family: "continuation",
    profile: "full",
    title: "continue after asking to inspect current work",
    summary:
      "The user pauses to inspect the current result and then asks for one more edit.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "preview_visibility",
      "continue_task",
      "artifact_lookup",
    ],
    turns: [
      {
        speaker: "user",
        text: "Build me a compact dashboard for active tasks.",
      },
      { speaker: "user", text: "Can I see it?" },
      { speaker: "user", text: "Okay now add a tiny recent-history section." },
    ],
    doneWhen: [
      "The preview request returns a real artifact or URL.",
      "The subsequent edit continues the existing task.",
    ],
    evidence: ["artifacts", "task thread", "changed files"],
  }),
  scenario({
    id: "P001",
    family: "preview_and_share",
    profile: "smoke",
    title: "answer 'can I see it' with a real artifact",
    summary:
      "The user asks for visibility into produced work and expects a concrete view path.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["preview_visibility", "artifact_lookup"],
    turns: [
      {
        speaker: "user",
        text: "Make a tiny webpage that just says hello in a dramatic font.",
      },
      { speaker: "user", text: "Can I see it?" },
    ],
    doneWhen: [
      "The agent returns a concrete artifact, file path, or URL.",
      "The result is attached or discoverable from the task thread.",
    ],
    evidence: ["artifacts", "task thread", "transcripts"],
  }),
  scenario({
    id: "P002",
    family: "preview_and_share",
    profile: "core",
    title: "remote view without a hardcoded transport",
    summary:
      "The user asks to view the result from a remote machine and the agent must discover viable sharing options.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "share_discovery",
      "preview_visibility",
      "environment_detection",
    ],
    turns: [
      {
        speaker: "user",
        text: "Build a tiny page for me with today's moon phase.",
      },
      { speaker: "user", text: "How do I view that from a remote computer?" },
    ],
    doneWhen: [
      "The agent inspects available share mechanisms.",
      "The response either provides a real remote path or clearly states which capability is missing.",
    ],
    evidence: ["task artifacts", "task events", "trajectory records"],
  }),
  scenario({
    id: "P003",
    family: "preview_and_share",
    profile: "core",
    title: "send a link back over the originating connector",
    summary:
      "The user wants the output link sent back in the same channel context.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "share_discovery",
      "connector_response",
      "artifact_lookup",
    ],
    turns: [
      { speaker: "user", text: "Build a one-page weather card." },
      { speaker: "user", text: "Pull it up for me." },
      {
        speaker: "user",
        text: "If I'm on Discord, just send me the link there.",
      },
    ],
    doneWhen: [
      "The resulting message is emitted on the originating channel.",
      "If a shareable link exists, it is returned in-channel.",
    ],
    evidence: ["connector-sourced response", "artifacts", "trajectory records"],
  }),
  scenario({
    id: "P004",
    family: "preview_and_share",
    profile: "full",
    title: "share a generated static artifact instead of a dev server",
    summary:
      "The agent should recognize when a file download or static artifact is more appropriate than a live URL.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["artifact_lookup", "share_discovery"],
    turns: [
      {
        speaker: "user",
        text: "Generate a tiny printable HTML birthday card.",
      },
      { speaker: "user", text: "What's the easiest way for me to get that?" },
    ],
    doneWhen: [
      "The agent returns the most appropriate artifact path, URI, or attachment route.",
    ],
    evidence: ["artifacts", "task thread", "changed files"],
  }),
  scenario({
    id: "S001",
    family: "pause_resume_stop",
    profile: "smoke",
    title: "pause a task for review and resume it later",
    summary:
      "The user wants to pause ongoing work, discuss it, then continue from preserved state.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_control", "pause_task", "resume_task"],
    turns: [
      { speaker: "user", text: "Build a tiny portfolio page for me." },
      {
        speaker: "user",
        text: "Hold on a second, can you pause that and let's discuss if it's right?",
      },
      { speaker: "user", text: "Okay, make it so." },
    ],
    doneWhen: [
      "The thread enters a paused or waiting-on-user state.",
      "The state is preserved across the discussion turn.",
      "The task resumes instead of starting over.",
    ],
    evidence: [
      "task thread status changes",
      "task events",
      "trajectory records",
    ],
  }),
  scenario({
    id: "S002",
    family: "pause_resume_stop",
    profile: "smoke",
    title: "stop a running task when the user says stop",
    summary:
      "The user issues an urgent stop request and expects the task to halt without losing audit history.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_control", "stop_task"],
    turns: [
      { speaker: "user", text: "Make a small reminder dashboard." },
      { speaker: "user", text: "Stop, stop, stop doing what you're doing." },
    ],
    doneWhen: [
      "The task session is stopped.",
      "The thread remains queryable afterward.",
    ],
    evidence: ["task events", "task thread", "transcripts"],
  }),
  scenario({
    id: "S003",
    family: "pause_resume_stop",
    profile: "core",
    title: "pause when the user says the work is wrong",
    summary:
      "The agent should stop pushing forward and ask for clarification when told the current direction is wrong.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_control", "clarification_after_pause"],
    turns: [
      {
        speaker: "user",
        text: "Build a mini stats panel for my current tasks.",
      },
      { speaker: "user", text: "Hey wait, that's not right." },
    ],
    doneWhen: [
      "The task is paused or held.",
      "The agent asks a clarifying follow-up instead of continuing blindly.",
    ],
    evidence: ["task events", "trajectory records", "task thread status"],
  }),
  scenario({
    id: "S004",
    family: "pause_resume_stop",
    profile: "core",
    title: "resume with a specific correction",
    summary:
      "The user corrects the plan after pausing and the agent resumes the same work item.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_control", "resume_task", "continue_task"],
    turns: [
      { speaker: "user", text: "Build me a tiny status page." },
      { speaker: "user", text: "Pause that." },
      {
        speaker: "user",
        text: "Okay continue, but make it text-only and minimal.",
      },
    ],
    doneWhen: [
      "The original thread is resumed with new instructions.",
      "Additional file or artifact updates occur after resume.",
    ],
    evidence: ["task thread events", "changed files", "trajectory records"],
  }),
  scenario({
    id: "H001",
    family: "history_and_reporting",
    profile: "smoke",
    title: "what are you working on right now",
    summary:
      "The user asks for active task status without wanting raw logs dumped into context.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_history", "active_status"],
    turns: [{ speaker: "user", text: "What are you working on right now?" }],
    doneWhen: [
      "The answer comes from coordinator state or task history lookup.",
      "The response summarizes active tasks without dumping huge raw transcripts.",
    ],
    evidence: ["task history query", "trajectory records"],
  }),
  scenario({
    id: "H002",
    family: "history_and_reporting",
    profile: "smoke",
    title: "what tasks do you have going on",
    summary:
      "The agent should enumerate ongoing tracked tasks and their states.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_history", "active_status"],
    turns: [{ speaker: "user", text: "What tasks do you have going on?" }],
    doneWhen: ["The response includes currently active or waiting threads."],
    evidence: ["task history query", "task thread summaries"],
  }),
  scenario({
    id: "H003",
    family: "history_and_reporting",
    profile: "core",
    title: "show tasks from yesterday",
    summary: "The user asks for prior work by time window.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_history", "time_window_lookup"],
    turns: [
      { speaker: "user", text: "Can you show me what tasks we did yesterday?" },
    ],
    doneWhen: [
      "The response uses a date-window query over task history.",
      "The result is time-bounded instead of a full-history dump.",
    ],
    evidence: ["task history query", "trajectory records"],
  }),
  scenario({
    id: "H004",
    family: "history_and_reporting",
    profile: "core",
    title: "search last week by topic",
    summary: "The user asks for a topical search over the previous week.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "task_history",
      "time_window_lookup",
      "search_lookup",
    ],
    turns: [
      {
        speaker: "user",
        text: "In the last week, give me all tasks where we were working on the Discord connector.",
      },
    ],
    doneWhen: ["The response combines time window and topic filtering."],
    evidence: ["task thread search", "task history query"],
  }),
  scenario({
    id: "H005",
    family: "history_and_reporting",
    profile: "core",
    title: "count task volume without polluting context",
    summary: "The user asks for counts and expects a concise answer.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_history", "count_lookup"],
    turns: [{ speaker: "user", text: "How many tasks have we done so far?" }],
    doneWhen: [
      "The answer is produced from durable state.",
      "The response is concise and count-oriented.",
    ],
    evidence: ["task history query", "db assertions"],
  }),
  scenario({
    id: "H006",
    family: "history_and_reporting",
    profile: "full",
    title: "explain why a task is blocked",
    summary: "The user asks for status plus reason, not just a state label.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_history", "task_detail_lookup"],
    turns: [{ speaker: "user", text: "Why is that task blocked?" }],
    doneWhen: [
      "The response identifies the relevant thread and summarizes the blocking reason.",
    ],
    evidence: ["task detail lookup", "pending decisions", "task events"],
  }),
  scenario({
    id: "R001",
    family: "research_and_planning",
    profile: "core",
    title: "deep research with live provider backing",
    summary:
      "The user asks for research that should run on live providers and produce a report artifact.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "create_task",
      "live_provider_execution",
      "artifact_reporting",
    ],
    turns: [
      {
        speaker: "user",
        text: "Research the best current options for local-first connector observability and write me a recommendation.",
      },
      {
        speaker: "user",
        text: "Can you put the findings somewhere I can read them?",
      },
    ],
    doneWhen: [
      "A research task runs on a live provider-backed framework.",
      "A report artifact is attached to the thread.",
    ],
    evidence: ["task artifacts", "trajectory records", "task thread"],
  }),
  scenario({
    id: "R002",
    family: "research_and_planning",
    profile: "core",
    title: "ask for a plan, then implicitly approve it",
    summary:
      "The user asks for a plan and then gives a vague approval utterance.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["planning", "implicit_approval", "task_execution"],
    turns: [
      {
        speaker: "user",
        text: "Plan how you'd test the coordinator against lots of nuanced user requests.",
      },
      { speaker: "user", text: "Yeah sounds good, do it." },
    ],
    doneWhen: [
      "The agent distinguishes planning from execution.",
      "The approval starts execution rather than producing another plan.",
    ],
    evidence: ["task thread", "trajectory records", "artifacts"],
  }),
  scenario({
    id: "R003",
    family: "research_and_planning",
    profile: "full",
    title: "parallel subtasks for research and synthesis",
    summary: "The user asks for parallel work and expects coordinated output.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["multi_agent_coordination", "artifact_reporting"],
    turns: [
      {
        speaker: "user",
        text: "Split this into a few parallel task agents: one researches, one compares tradeoffs, one writes the summary.",
      },
    ],
    doneWhen: [
      "Multiple sessions attach to one logical thread or clearly related threads.",
      "A final synthesis artifact exists.",
    ],
    evidence: ["multiple sessions", "task thread", "artifacts"],
  }),
  scenario({
    id: "K001",
    family: "connector_behavior",
    profile: "smoke",
    title: "respond appropriately from a Discord-origin message",
    summary:
      "The same conversational request should run through Discord semantics and still create durable Eliza state.",
    channels: ["discord"],
    requiredCapabilities: ["connector_ingress", "task_execution"],
    turns: [
      {
        speaker: "user",
        text: "Build me a tiny page that says hi from Discord.",
      },
      { speaker: "user", text: "Can I see it?" },
    ],
    doneWhen: [
      "The run is recorded as connector-originated.",
      "A task thread and trajectories exist in Eliza.",
    ],
    evidence: ["connector trajectory", "task thread", "artifacts"],
  }),
  scenario({
    id: "K002",
    family: "connector_behavior",
    profile: "core",
    title: "connector follow-up continues the same task",
    summary:
      "A second turn on the same connector should continue existing work instead of starting over.",
    channels: ["discord", "telegram", "slack"],
    requiredCapabilities: ["connector_ingress", "continue_task"],
    turns: [
      { speaker: "user", text: "Build a tiny countdown page." },
      { speaker: "user", text: "Now add a darker version too." },
    ],
    doneWhen: ["The same connector session or thread is reused for follow-up."],
    evidence: ["task thread", "connector trajectory", "changed files"],
  }),
  scenario({
    id: "K003",
    family: "connector_behavior",
    profile: "full",
    title: "connector permission failures are surfaced cleanly",
    summary:
      "A channel with task-agent policy restrictions should return an explicit denial instead of failing silently.",
    channels: ["discord"],
    requiredCapabilities: ["connector_ingress", "policy_enforcement"],
    turns: [
      {
        speaker: "user",
        text: "Start a background task agent to make a little site for me.",
      },
    ],
    doneWhen: [
      "If policy blocks the action, the denial is explicit and auditable.",
    ],
    evidence: [
      "task policy events",
      "connector response",
      "trajectory records",
    ],
  }),
  scenario({
    id: "F001",
    family: "recovery_and_failover",
    profile: "core",
    title: "framework failover after quota exhaustion",
    summary:
      "The coordinator should continue work when one live framework is temporarily exhausted.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["framework_failover", "task_recovery"],
    turns: [
      {
        speaker: "user",
        text: "Take a deep pass on this problem and keep going even if one provider fails.",
      },
    ],
    doneWhen: [
      "A failover event is recorded when the first framework becomes unavailable.",
      "A replacement session continues the same task.",
    ],
    evidence: ["task events", "sessions", "trajectory records"],
  }),
  scenario({
    id: "F002",
    family: "recovery_and_failover",
    profile: "full",
    title: "runtime restart leaves tasks auditable",
    summary: "Interrupted tasks must still be queryable after restart.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["interrupt_recovery", "task_history"],
    turns: [
      { speaker: "user", text: "What task was interrupted most recently?" },
    ],
    doneWhen: ["Interrupted sessions are visible in history."],
    evidence: ["task history query", "task status", "task events"],
  }),
  scenario({
    id: "T001",
    family: "task_management",
    profile: "core",
    title: "show the current task list and then drill into one item",
    summary:
      "The user asks for a list and then asks for a specific item to be shown.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_history", "task_detail_lookup"],
    turns: [
      { speaker: "user", text: "Show me the current task list." },
      { speaker: "user", text: "Open the most recent one." },
    ],
    doneWhen: [
      "The first turn returns a bounded summary.",
      "The second returns thread-level detail without dumping raw terminal noise.",
    ],
    evidence: ["task history query", "task detail lookup"],
  }),
  scenario({
    id: "T002",
    family: "task_management",
    profile: "core",
    title: "archive and reopen task history",
    summary:
      "The user wants to clean up old work but still keep it recoverable.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_control", "archive_task", "reopen_task"],
    turns: [
      { speaker: "user", text: "Archive that finished task." },
      { speaker: "user", text: "Actually reopen it." },
    ],
    doneWhen: [
      "The task thread is archived.",
      "The same thread can be reopened.",
    ],
    evidence: ["task thread status", "task events"],
  }),
  scenario({
    id: "T003",
    family: "task_management",
    profile: "full",
    title: "continue a paused task with specific guidance",
    summary:
      "A paused task should preserve context and accept new instructions.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_control", "continue_task"],
    turns: [
      { speaker: "user", text: "Pause that task for now." },
      {
        speaker: "user",
        text: "Okay continue, but prioritize the mobile layout first.",
      },
    ],
    doneWhen: ["The same thread resumes with the new directive."],
    evidence: ["task thread events", "changed files"],
  }),
  scenario({
    id: "V001",
    family: "visibility_and_audit",
    profile: "smoke",
    title: "every run emits trajectories and task-thread evidence",
    summary:
      "The scenario system should be able to prove that chat, coordinator, and PTY evidence all exist.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "trajectory_logging",
      "task_thread_logging",
      "artifact_logging",
    ],
    turns: [
      {
        speaker: "user",
        text: "Make a tiny file that says the eval is working.",
      },
    ],
    doneWhen: [
      "At least one trajectory exists for the run.",
      "A task thread exists when task work was required.",
      "Artifacts or changed files are recorded.",
    ],
    evidence: [
      "trajectory records",
      "task thread",
      "artifacts",
      "changed files",
    ],
  }),
  scenario({
    id: "V002",
    family: "visibility_and_audit",
    profile: "core",
    title: "export a run bundle for later inspection",
    summary:
      "A completed scenario run should export a durable bundle of everything needed for review.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "bundle_export",
      "trajectory_export",
      "report_generation",
    ],
    turns: [
      { speaker: "user", text: "Run the scenario and save all the evidence." },
    ],
    doneWhen: [
      "A report bundle is written.",
      "The bundle references trajectories, threads, artifacts, and changed files.",
    ],
    evidence: ["bundle manifest", "trajectory export", "task-thread detail"],
  }),
  scenario({
    id: "V003",
    family: "visibility_and_audit",
    profile: "full",
    title: "group runs by scenario and batch identifiers",
    summary:
      "The evaluator must be able to retrieve trajectories by scenario and batch.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "scenario_tagging",
      "batch_tagging",
      "trajectory_export",
    ],
    turns: [{ speaker: "user", text: "Run a tagged evaluation batch." }],
    doneWhen: [
      "Trajectory filters by scenario and batch return the expected runs.",
    ],
    evidence: ["trajectory API filters", "report bundle"],
  }),
  scenario({
    id: "B006",
    family: "build_and_edit",
    profile: "core",
    title: "build a tiny CLI and revise its output format",
    summary:
      "The user asks for a small command-line tool and then asks for a format change without restarting the task.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["create_task", "continue_task", "iterative_editing"],
    turns: [
      {
        speaker: "user",
        text: "Make me a tiny CLI that prints my birthday countdown in days.",
      },
      {
        speaker: "user",
        text: "Actually make the output JSON instead of plain text.",
      },
    ],
    doneWhen: [
      "The CLI is created in files.",
      "The output-format change updates the same task instead of spawning a new one.",
    ],
    evidence: ["task thread", "changed files", "trajectory records"],
  }),
  scenario({
    id: "B007",
    family: "build_and_edit",
    profile: "full",
    title: "add a small feature in the same repo from prior context",
    summary:
      "The user references the current repo implicitly and expects the agent to stay in that project.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "repo_tasking",
      "continue_task",
      "worktree_artifacts",
    ],
    turns: [
      {
        speaker: "user",
        text: "In the same repo, add a small page that lists archived tasks too.",
      },
      { speaker: "user", text: "Show me which files changed." },
    ],
    doneWhen: [
      "The repo context is reused correctly.",
      "Changed files in the existing workspace are surfaced.",
    ],
    evidence: ["task thread", "changed files", "artifacts"],
  }),
  scenario({
    id: "C005",
    family: "continuation",
    profile: "core",
    title: "treat keep-going language as continuation",
    summary:
      "The user uses loose continuation language and expects the same task to keep moving.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["continue_task", "thread_lookup"],
    turns: [
      { speaker: "user", text: "Make me a tiny habit tracker page." },
      { speaker: "user", text: "Okay keep going with that." },
      { speaker: "user", text: "Now make it feel a little more serious." },
    ],
    doneWhen: ["All turns stay on one task thread."],
    evidence: ["task thread updates", "changed files"],
  }),
  scenario({
    id: "C006",
    family: "continuation",
    profile: "full",
    title: "interpret same-project follow-up after a completed answer",
    summary:
      "The user asks a new but related change after the agent already reported completion.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["continue_task", "thread_lookup", "repo_tasking"],
    turns: [
      { speaker: "user", text: "Build me a tiny changelog viewer." },
      {
        speaker: "user",
        text: "Cool, in that same project add a filter for only today.",
      },
    ],
    doneWhen: [
      "The follow-up is attached to the prior work item or clearly linked task history.",
    ],
    evidence: ["task thread", "changed files", "task events"],
  }),
  scenario({
    id: "P005",
    family: "preview_and_share",
    profile: "core",
    title: "surface the direct file path when that is the best view mechanism",
    summary:
      "The user does not need a server link; the agent should provide the artifact itself.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["artifact_lookup", "preview_visibility"],
    turns: [
      { speaker: "user", text: "Make me a little printable checklist page." },
      { speaker: "user", text: "Where is the actual file?" },
    ],
    doneWhen: ["A direct artifact path or attachment route is returned."],
    evidence: ["artifacts", "task thread", "trajectory records"],
  }),
  scenario({
    id: "S005",
    family: "pause_resume_stop",
    profile: "core",
    title:
      "pause a research task and then convert the pause into a new direction",
    summary:
      "The user interrupts the current direction and redirects the same task after discussion.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_control", "pause_task", "continue_task"],
    turns: [
      {
        speaker: "user",
        text: "Research options for connector observability.",
      },
      {
        speaker: "user",
        text: "Hold that thought. I care more about logging and trajectories than dashboards.",
      },
      { speaker: "user", text: "Okay continue with that new emphasis." },
    ],
    doneWhen: [
      "The task pauses for redirection.",
      "The resumed work reflects the corrected emphasis.",
    ],
    evidence: ["task events", "task thread status", "artifacts"],
  }),
  scenario({
    id: "H007",
    family: "history_and_reporting",
    profile: "full",
    title: "list blocked tasks from the last week",
    summary: "The user wants a filtered operational view, not a raw dump.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "task_history",
      "time_window_lookup",
      "search_lookup",
    ],
    turns: [
      {
        speaker: "user",
        text: "Show me every blocked task from the last week.",
      },
    ],
    doneWhen: [
      "The answer is bounded to blocked tasks in the requested window.",
    ],
    evidence: ["task history query", "task thread summaries"],
  }),
  scenario({
    id: "H008",
    family: "history_and_reporting",
    profile: "full",
    title: "search recent work by topic and completion state",
    summary: "The user asks for recent finished work on a topic.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "task_history",
      "time_window_lookup",
      "search_lookup",
    ],
    turns: [
      {
        speaker: "user",
        text: "What finished work did we do recently on calendar stuff?",
      },
    ],
    doneWhen: [
      "The response combines topical search with status-aware filtering.",
    ],
    evidence: ["task history query", "db assertions"],
  }),
  scenario({
    id: "R004",
    family: "research_and_planning",
    profile: "full",
    title: "research a comparison and deliver it in a structured artifact",
    summary:
      "The user wants a comparative output that should result in a concrete written artifact.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "create_task",
      "live_provider_execution",
      "artifact_reporting",
    ],
    turns: [
      {
        speaker: "user",
        text: "Compare Codex and Claude for coordinator task work and put it in a small table I can read.",
      },
      { speaker: "user", text: "Can you save that somewhere?" },
    ],
    doneWhen: [
      "A research artifact is produced.",
      "The artifact is attached or discoverable through the thread.",
    ],
    evidence: ["artifacts", "task thread", "trajectory records"],
  }),
  scenario({
    id: "K004",
    family: "connector_behavior",
    profile: "core",
    title: "WhatsApp-origin request continues across follow-up turns",
    summary:
      "The agent should preserve connector-origin context through multiple turns.",
    channels: ["whatsapp"],
    requiredCapabilities: ["connector_ingress", "continue_task"],
    turns: [
      { speaker: "user", text: "Make me a tiny quote card." },
      { speaker: "user", text: "Now give it a second style too." },
      { speaker: "user", text: "Can I see both?" },
    ],
    doneWhen: ["The WhatsApp-origin thread persists across follow-up turns."],
    evidence: ["connector trajectory", "task thread", "artifacts"],
  }),
  scenario({
    id: "K005",
    family: "connector_behavior",
    profile: "full",
    title: "Matrix-origin pause and resume flow",
    summary:
      "Connector-origin conversations should support interruption controls too.",
    channels: ["matrix"],
    requiredCapabilities: ["connector_ingress", "task_control", "resume_task"],
    turns: [
      {
        speaker: "user",
        text: "Build a tiny status card for my current tasks.",
      },
      { speaker: "user", text: "Pause that." },
      { speaker: "user", text: "Okay continue and add a recent history list." },
    ],
    doneWhen: [
      "The task pauses and resumes within the same connector-origin flow.",
    ],
    evidence: ["connector trajectory", "task events", "changed files"],
  }),
  scenario({
    id: "F003",
    family: "recovery_and_failover",
    profile: "full",
    title:
      "missing provider readiness is surfaced as a concrete failure reason",
    summary:
      "If a framework cannot run because auth or installation is missing, the failure should be explicit and auditable.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["framework_failover", "task_recovery"],
    turns: [
      {
        speaker: "user",
        text: "Use whichever task agent can actually run this and tell me clearly if one is unavailable.",
      },
    ],
    doneWhen: [
      "Any framework readiness issue is surfaced explicitly in task evidence or response text.",
    ],
    evidence: ["task events", "trajectory records", "task thread"],
  }),
  scenario({
    id: "T004",
    family: "task_management",
    profile: "full",
    title: "stop one task while leaving the rest alone",
    summary: "The user wants granular task control rather than a global stop.",
    channels: ALL_CHANNELS,
    requiredCapabilities: ["task_control", "task_detail_lookup", "stop_task"],
    turns: [
      { speaker: "user", text: "Show me the current task list." },
      {
        speaker: "user",
        text: "Stop the most recent one, but leave the others running.",
      },
    ],
    doneWhen: [
      "One task is interrupted or stopped without wiping the rest of the task list.",
    ],
    evidence: ["task thread status", "task history query", "task events"],
  }),
  scenario({
    id: "V004",
    family: "visibility_and_audit",
    profile: "full",
    title: "task threads are retrievable by scenario and batch identifiers",
    summary:
      "The evaluator must be able to retrieve coordinator task state with the same scenario and batch tags used for trajectories.",
    channels: ALL_CHANNELS,
    requiredCapabilities: [
      "scenario_tagging",
      "batch_tagging",
      "task_thread_logging",
    ],
    turns: [
      {
        speaker: "user",
        text: "Run this as a tagged coordinator evaluation and make sure the task history is grouped with it.",
      },
    ],
    doneWhen: [
      "Task thread queries scoped by scenario and batch return the expected run.",
    ],
    evidence: [
      "task thread query filters",
      "trajectory records",
      "bundle manifest",
    ],
  }),
];

export const coordinatorScenarioById = new Map(
  coordinatorScenarios.map((item) => [item.id, item] as const),
);

export function listCoordinatorScenarios(
  profile: CoordinatorScenarioProfile = "full",
): CoordinatorScenario[] {
  if (profile === "full") {
    return coordinatorScenarios.slice();
  }

  const allowedProfiles =
    profile === "smoke"
      ? new Set<CoordinatorScenarioProfile>(["smoke"])
      : new Set<CoordinatorScenarioProfile>(["smoke", "core"]);
  return coordinatorScenarios.filter((item) =>
    allowedProfiles.has(item.profile),
  );
}

export function countCoordinatorScenariosByFamily(): Record<
  CoordinatorScenarioFamily,
  number
> {
  const counts = {
    build_and_edit: 0,
    continuation: 0,
    preview_and_share: 0,
    pause_resume_stop: 0,
    history_and_reporting: 0,
    research_and_planning: 0,
    connector_behavior: 0,
    recovery_and_failover: 0,
    task_management: 0,
    visibility_and_audit: 0,
  } satisfies Record<CoordinatorScenarioFamily, number>;

  for (const item of coordinatorScenarios) {
    counts[item.family] += 1;
  }

  return counts;
}
